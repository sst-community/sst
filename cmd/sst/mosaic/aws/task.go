package aws

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
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
				go func() {
					done := make(chan struct{})
					wait, err := startWithOutput(cmd, onLine, func(err error) {
						log.Error("failed to read task output", "taskID", body.TaskID, "err", err)
					})
					if err != nil {
						log.Error("failed to start task", "taskID", body.TaskID, "err", err)
					}
					bus.Publish(&TaskStartEvent{
						TaskID:   body.TaskID,
						WorkerID: msg.Source,
						Command:  cmd.String(),
					})
					go func() {
						wait()
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

// How long a task's output is still read after its command exits. What's left
// in the pipes takes far less. A process the command started in the background
// can keep them open, and the task is done without waiting for it.
var taskOutputGrace = time.Second

// startWithOutput starts cmd and passes each line it prints, on stdout or
// stderr, to onLine. The wait it returns waits for cmd to exit, then for the
// rest of its output, up to taskOutputGrace. When cmd can't start, wait
// returns at once.
func startWithOutput(cmd *exec.Cmd, onLine func(string), onReadError func(error)) (wait func(), err error) {
	// The pipes are made here, not with StdoutPipe, as Wait closes those once
	// the command exits, which can lose the last of its output.
	readers := []*os.File{}
	writers := []*os.File{}
	closeAll := func(files []*os.File) {
		for _, f := range files {
			f.Close()
		}
	}
	for range 2 {
		r, w, err := os.Pipe()
		if err != nil {
			closeAll(readers)
			closeAll(writers)
			return func() {}, err
		}
		readers = append(readers, r)
		writers = append(writers, w)
	}
	cmd.Stdout, cmd.Stderr = writers[0], writers[1]
	err = cmd.Start()
	// the command has its own copies
	closeAll(writers)
	if err != nil {
		closeAll(readers)
		return func() {}, err
	}

	var reading sync.WaitGroup
	for _, r := range readers {
		reading.Go(func() {
			err := process.ReadLines(r, maxOutputLine, onLine, func() { onLine(tooLongNote("task")) })
			if err != nil && !errors.Is(err, os.ErrClosed) {
				onReadError(err)
				// Keep reading, or the command blocks on a full pipe.
				io.Copy(io.Discard, r)
			}
		})
	}
	read := make(chan struct{})
	go func() {
		reading.Wait()
		close(read)
	}()
	return func() {
		cmd.Wait()
		select {
		case <-read:
		case <-time.After(taskOutputGrace):
			// something the command started holds its output open
			closeAll(readers)
			select {
			case <-read:
			case <-time.After(taskOutputGrace):
			}
		}
	}, nil
}
