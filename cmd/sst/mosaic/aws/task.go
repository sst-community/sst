package aws

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ecs"
	"github.com/aws/aws-sdk-go-v2/service/ecs/types"
	"github.com/kballard/go-shellquote"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/process"
	"github.com/sst/sst/v3/pkg/project"
)

type TaskProvisionEvent struct {
	Name string
}

type TaskStartEvent struct {
	TaskID   string
	WorkerID string
	Command  string
}

type TaskLogEvent struct {
	TaskID   string
	WorkerID string
	Line     string
}

type TaskCompleteEvent struct {
	TaskID   string
	WorkerID string
}

type TaskMissingCommandEvent struct {
	Name string
}

func task(ctx context.Context, input input) {
	log := slog.Default().With("service", "aws.task")
	log.Info("starting")
	defer log.Info("done")
	events := bus.Subscribe(&project.CompleteEvent{})
	var complete *project.CompleteEvent

	ticker := time.NewTicker(time.Second * 3)
	defer ticker.Stop()

	ecsClient := ecs.NewFromConfig(input.config)
	trackedTasks := map[string]bool{}

	var cloudLogs *pendingLogs
	if flag.SST_DEV_CLOUDWATCH_LOGS {
		cloudLogs = newPendingLogs()
	}
	// sendLogs sends the task's stand-in what its command printed since the last
	// time, for it to print in the task's log group.
	sendLogs := func(workerID string) {
		lines, dropped := cloudLogs.take(workerID)
		if len(lines) == 0 && dropped == 0 {
			return
		}
		body, err := json.Marshal(bridge.LogsBody{Lines: lines, Dropped: dropped})
		if err != nil {
			log.Error("failed to encode logs", "workerID", workerID, "err", err)
			return
		}
		writer := input.client.NewWriter(bridge.MessageLogs, input.prefix+"/"+workerID+"/in")
		if err := sendMessage(writer, bytes.NewReader(body)); err != nil {
			log.Error("failed to send logs", "workerID", workerID, "err", err)
		}
	}

	for {
		select {
		case <-ticker.C:
			if complete == nil || len(complete.Tasks) == 0 {
				continue
			}
			for _, item := range complete.Resources {
				if item.URN.Type() != "aws:ecs/cluster:Cluster" {
					continue
				}
				name := item.Outputs["name"]
				tasks, err := ecsClient.ListTasks(ctx, &ecs.ListTasksInput{
					Cluster:       aws.String(name.(string)),
					DesiredStatus: types.DesiredStatusRunning,
				})
				if err != nil {
					continue
				}
				dirty := []string{}
				for _, task := range tasks.TaskArns {
					if _, ok := trackedTasks[task]; !ok {
						dirty = append(dirty, task)
						trackedTasks[task] = true
						continue
					}
				}
				if len(dirty) == 0 {
					continue
				}
				log.Info("describing tasks", "tasks", dirty)
				described, err := ecsClient.DescribeTasks(ctx, &ecs.DescribeTasksInput{
					Tasks:   dirty,
					Cluster: aws.String(name.(string)),
				})
				if err != nil {
					continue
				}
				for _, item := range described.Tasks {
					bus.Publish(&TaskProvisionEvent{
						Name: *item.Containers[0].Name,
					})
					log.Info("task status", "status", *item.LastStatus, "desired", *item.LastStatus, "tags", item.Tags)
					if err != nil {
						continue
					}
				}
			}
			break

		case <-ctx.Done():
			return

		case msg := <-input.msg:
			if complete == nil {
				continue
			}
			switch msg.Type {
			case bridge.MessageTaskStart:
				log.Info("starting task", "task", task)
				body := bridge.TaskStartBody{}
				json.NewDecoder(msg.Body).Decode(&body)
				task, ok := complete.Tasks[body.TaskID]
				if !ok {
					continue
				}
				if task.Command == nil {
					bus.Publish(&TaskMissingCommandEvent{
						Name: task.Name,
					})
					continue
				}
				fields, err := shellquote.Split(*task.Command)
				if err != nil {
					log.Error("failed to parse command", "err", err)
					continue
				}
				cmd := process.Command(fields[0], fields[1:]...)
				cmd.Dir = task.Directory
				cmd.Env = append(os.Environ(), body.Environment...)
				stdout, _ := cmd.StdoutPipe()
				stderr, _ := cmd.StderrPipe()
				onLine := func(line string) {
					if cloudLogs != nil {
						cloudLogs.add(msg.Source, line)
					}
					bus.Publish(&TaskLogEvent{
						TaskID:   body.TaskID,
						WorkerID: msg.Source,
						Line:     line,
					})
				}
				var readers sync.WaitGroup
				read := func(r io.Reader) {
					defer readers.Done()
					err := process.ReadLines(r, maxOutputLine, onLine, func() { onLine(tooLongNote("task")) })
					if err != nil {
						log.Error("failed to read task output", "taskID", body.TaskID, "err", err)
						// Keep reading, or the command blocks on a full pipe.
						io.Copy(io.Discard, r)
					}
				}
				readers.Add(2)
				go read(stdout)
				go read(stderr)
				go func() {
					done := make(chan struct{})
					cmd.Start()
					bus.Publish(&TaskStartEvent{
						TaskID:   body.TaskID,
						WorkerID: msg.Source,
						Command:  cmd.String(),
					})
					go func() {
						// Wait closes the pipes, so the output is read to its end first.
						readers.Wait()
						cmd.Wait()
						done <- struct{}{}
					}()
					ping := func() {
						writer := input.client.NewWriter(bridge.MessagePing, input.prefix+"/"+msg.Source+"/in")
						json.NewEncoder(writer).Encode(bridge.PingBody{})
						writer.Close()
					}
					ping()
					pings := time.NewTicker(time.Second * 5)
					defer pings.Stop()
					var flushes <-chan time.Time
					if cloudLogs != nil {
						ticker := time.NewTicker(time.Second)
						defer ticker.Stop()
						flushes = ticker.C
					}
					for {
						select {
						case <-pings.C:
							ping()
						case <-flushes:
							sendLogs(msg.Source)
						case <-done:
							if cloudLogs != nil {
								sendLogs(msg.Source)
							}
							writer := input.client.NewWriter(bridge.MessageTaskComplete, input.prefix+"/"+msg.Source+"/in")
							json.NewEncoder(writer).Encode(bridge.TaskCompleteBody{})
							writer.Close()
							bus.Publish(&TaskCompleteEvent{
								TaskID:   body.TaskID,
								WorkerID: msg.Source,
							})
							return
						case <-ctx.Done():
							return
						}
					}
				}()
			}
			break

		case unknown := <-events:
			switch evt := unknown.(type) {
			case *project.CompleteEvent:
				complete = evt
			}
			break
		}
	}
}
