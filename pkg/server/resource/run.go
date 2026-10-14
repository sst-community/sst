package resource

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"

	"github.com/sst/sst/v3/cmd/sst/mosaic/ui/common"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/process"
	"golang.org/x/sync/semaphore"
)

// The longest line of command output that is passed on, 1 MB. A longer line is
// logged and the rest of the output is read and dropped.
const maxOutputLine = 1024 * 1024

// Semaphore to limit concurrent executions
type Run struct {
	lock *semaphore.Weighted
}

type RunInputs struct {
	Command string            `json:"command"`
	Cwd     string            `json:"cwd"`
	Env     map[string]string `json:"env"`
	Version string            `json:"version"`
}

type RunOutputs struct {
}

func NewRun() *Run {
	weight := int64(1)
	if flag.SST_BUILD_CONCURRENCY_SITE != "" {
		weight, _ = strconv.ParseInt(flag.SST_BUILD_CONCURRENCY_SITE, 10, 64)
	}

	return &Run{
		lock: semaphore.NewWeighted(weight),
	}
}

func (r *Run) Create(input *RunInputs, output *CreateResult[RunOutputs]) error {
	err := r.executeCommand(input)
	if err != nil {
		return err
	}

	*output = CreateResult[RunOutputs]{
		ID:   "run",
		Outs: RunOutputs{},
	}
	return nil
}

func (r *Run) Update(input *UpdateInput[RunInputs, RunOutputs], output *UpdateResult[RunOutputs]) error {
	err := r.executeCommand(&input.News)
	if err != nil {
		return err
	}

	*output = UpdateResult[RunOutputs]{
		Outs: RunOutputs{},
	}
	return nil
}

func (r *Run) executeCommand(input *RunInputs) error {
	r.lock.Acquire(context.Background(), 1)
	defer r.lock.Release(1)
	cmd := process.Command("sh", "-c", input.Command)
	cmd.Dir = input.Cwd
	cmd.Env = os.Environ()
	if len(input.Env) > 0 {
		for key, value := range input.Env {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	// One pipe for both. Reading stdout to its end before stderr (a MultiReader)
	// blocks the command once it writes more than a pipe holds to stderr, since
	// nobody reads that while stdout is still open.
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.Stdout = writer
	cmd.Stderr = writer
	err = cmd.Start()
	writer.Close()
	if err != nil {
		reader.Close()
		return err
	}
	defer reader.Close()
	scanner := bufio.NewScanner(reader)
	// a line can be longer than the 64 KB a scanner takes by default
	scanner.Buffer(make([]byte, 0, 64*1024), maxOutputLine)
	for scanner.Scan() {
		bus.Publish(&common.StdoutEvent{Line: scanner.Text()})
	}
	if err := scanner.Err(); err != nil {
		slog.Error("failed to read command output", "error", err, "cmd", cmd.String())
		if errors.Is(err, bufio.ErrTooLong) {
			bus.Publish(&common.StdoutEvent{Line: fmt.Sprintf("A line of the command's output is longer than %d MB. The rest of its output is not shown.", maxOutputLine/(1024*1024))})
		} else {
			bus.Publish(&common.StdoutEvent{Line: "The command's output could not be read to the end: " + err.Error()})
		}
		// Keep reading, or the command blocks on a full pipe once nobody reads it,
		// and Wait below never returns.
		io.Copy(io.Discard, reader)
	}
	slog.Info("waiting for command to finish", "cmd", cmd.String())
	cmd.Wait()
	if cmd.ProcessState.ExitCode() > 0 {
		return fmt.Errorf("command exited with code %d", cmd.ProcessState.ExitCode())
	}
	return nil
}
