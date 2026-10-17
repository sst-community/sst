package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/appsync"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/id"
)

var SST_APP = os.Getenv("SST_APP")
var SST_STAGE = os.Getenv("SST_STAGE")
var SST_TASK_ID = os.Getenv("SST_TASK_ID")
var SST_REGION = os.Getenv("SST_REGION")
var SST_APPSYNC_HTTP = os.Getenv("SST_APPSYNC_HTTP")
var SST_APPSYNC_REALTIME = os.Getenv("SST_APPSYNC_REALTIME")

var ENV_BLACKLIST = map[string]bool{
	"PATH": true,
}

// messageLogs is bridge.MessageLogs: what the task's command printed in sst dev,
// sent when SST_DEV_CLOUDWATCH_LOGS is set. This module builds against an older
// copy of the CLI's bridge package, which doesn't have it. Its number is kept by
// TestMessageTypesKeepTheirNumbers in that package.
const messageLogs bridge.MessageType = 10

// logsBody is the part of bridge.LogsBody a task's logs use.
type logsBody struct {
	Lines   []string `json:"lines"`
	Dropped int      `json:"dropped"`
}

func main() {
	if err := run(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}

func run() error {
	ctx, _ := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	workerID := id.Ascending()

	prefix := fmt.Sprintf("/sst/%s/%s", SST_APP, SST_STAGE)
	slog.Info("prefix", "value", prefix)
	config, err := config.LoadDefaultConfig(ctx, config.WithRegion(SST_REGION))
	if err != nil {
		return err
	}

	conn, err := appsync.Dial(ctx, config, SST_APPSYNC_HTTP, SST_APPSYNC_REALTIME)
	if err != nil {
		return err
	}
	client := bridge.NewClient(ctx, conn, workerID, prefix+"/"+workerID)

	init := bridge.TaskStartBody{
		TaskID:      SST_TASK_ID,
		Environment: []string{},
	}

	for _, e := range os.Environ() {
		key := strings.Split(e, "=")[0]
		if _, ok := ENV_BLACKLIST[key]; ok {
			continue
		}
		init.Environment = append(init.Environment, e)
	}
	creds, err := config.Credentials.Retrieve(ctx)
	if err != nil {
		return err
	}
	init.Environment = append(init.Environment, fmt.Sprintf("AWS_ACCESS_KEY_ID=%s", creds.AccessKeyID))
	init.Environment = append(init.Environment, fmt.Sprintf("AWS_SECRET_ACCESS_KEY=%s", creds.SecretAccessKey))
	init.Environment = append(init.Environment, fmt.Sprintf("AWS_SESSION_TOKEN=%s", creds.SessionToken))
	writer := client.NewWriter(bridge.MessageTaskStart, prefix+"/in")
	json.NewEncoder(writer).Encode(init)
	writer.Close()
	slog.Info("sent init")

	// What the command printed goes to this container's output, so it reaches the
	// task's log group. It's printed in the order it arrives, away from the loop,
	// so a message in several packets doesn't hold the loop up. When the task
	// completes, what's left is printed first.
	queue := make(chan bridge.Message, 100)
	printed := make(chan struct{})
	go func() {
		defer close(printed)
		for msg := range queue {
			var body logsBody
			if err := json.NewDecoder(msg.Body).Decode(&body); err != nil {
				slog.Error("failed to read the task's output", "err", err)
				continue
			}
			for _, line := range body.Lines {
				fmt.Println(line)
			}
			if body.Dropped > 0 {
				fmt.Printf("[sst dev] %d more lines were left out, over the limit for one second.\n", body.Dropped)
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case msg := <-client.Read():
			if msg.Source != "dev" {
				continue
			}
			switch msg.Type {
			case bridge.MessagePing:
				slog.Info("got ping")
				continue
			case messageLogs:
				queue <- msg
				continue
			case bridge.MessageTaskComplete:
				slog.Info("task complete")
				close(queue)
				select {
				case <-printed:
				case <-time.After(2 * time.Second):
				}
				return nil
			}
		case <-time.After(time.Second * 10):
			slog.Info("timeout")
			return nil
		}
	}

}
