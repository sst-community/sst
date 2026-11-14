// The bridge of a web function that's live in sst dev. Lambda starts it
// through index.mjs, and sends it the function's HTTP requests on
// AWS_LAMBDA_HTTP_ENDPOINT. It sends each to sst dev over AppSync, which sends
// it to the local server, and writes the response sst dev streams back.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/appsync"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge/web"
)

func main() {
	if err := run(); err != nil {
		slog.Error("run failed", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	endpoint := os.Getenv("AWS_LAMBDA_HTTP_ENDPOINT")
	if endpoint == "" {
		return fmt.Errorf("AWS_LAMBDA_HTTP_ENDPOINT is not set")
	}
	workerID := newWorkerID()
	prefix := fmt.Sprintf("/sst/%s/%s", os.Getenv("SST_APP"), os.Getenv("SST_STAGE"))
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(os.Getenv("SST_REGION")))
	if err != nil {
		return err
	}
	conn, err := appsync.Dial(ctx, cfg, os.Getenv("SST_APPSYNC_HTTP"), os.Getenv("SST_APPSYNC_REALTIME"))
	if err != nil {
		return err
	}
	client := bridge.NewClient(ctx, conn, workerID, prefix+"/"+workerID)
	// a response is streamed, so a packet AppSync lost is asked for
	client.AskForMissingOn(prefix + "/in")

	b := &web.Bridge{
		Client:      client,
		Prefix:      prefix,
		WorkerID:    workerID,
		FunctionID:  os.Getenv("SST_FUNCTION_ID"),
		TakeTimeout: takeTimeoutOf(os.Getenv("SST_FUNCTION_TIMEOUT")),
		Reconnect:   func(ctx context.Context) { conn.Reconnect(ctx) },
	}
	go b.Run(ctx)
	// Lambda sends requests once the server listens, so the subscription is
	// checked first
	b.Probe(ctx)

	listener, err := net.Listen("tcp", endpoint)
	if err != nil {
		return err
	}
	slog.Info("listening", "endpoint", endpoint, "workerID", workerID)
	server := &http.Server{Handler: b, ReadHeaderTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		server.Shutdown(shutdown)
	}()
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// newWorkerID names this environment, for sst dev to answer it on its own
// channel.
func newWorkerID() string {
	data := make([]byte, 16)
	rand.Read(data)
	return hex.EncodeToString(data)
}

// takeTimeoutOf is how long the bridge waits for sst dev to take a request,
// unless SST_FUNCTION_TIMEOUT sets it in milliseconds, as for a function.
func takeTimeoutOf(value string) time.Duration {
	ms, err := strconv.ParseInt(value, 10, 64)
	if err != nil || ms <= 0 {
		return web.DefaultTakeTimeout
	}
	return time.Duration(ms) * time.Millisecond
}
