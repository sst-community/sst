//go:build !windows

package node

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/sst/sst/v3/pkg/runtime"
)

// These run the real Node.js worker that sst dev starts for a function, against
// a stand-in for the runtime API that never hands it an invocation.

// startWorker runs the Node.js worker for a handler with the given code.
func startWorker(t *testing.T, code string) *Worker {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node isn't installed")
	}
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	dist := filepath.Join(repo, "platform", "dist", "nodejs-runtime", "index.js")
	if _, err := os.Stat(dist); err != nil {
		t.Skip("build the platform first: " + err.Error())
	}
	root := t.TempDir()
	platform := filepath.Join(root, ".sst", "platform", "dist", "nodejs-runtime")
	if err := os.MkdirAll(platform, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dist, filepath.Join(platform, "index.js")); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(root, "out")
	os.MkdirAll(out, 0755)
	if err := os.WriteFile(filepath.Join(out, "index.mjs"), []byte(code), 0644); err != nil {
		t.Fatal(err)
	}

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/invocation/next") {
			<-r.Context().Done()
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(api.Close)

	worker, err := New("dev").Run(t.Context(), &runtime.RunInput{
		CfgPath:  filepath.Join(root, "sst.config.ts"),
		Server:   api.Listener.Addr().(*net.TCPAddr).String(),
		WorkerID: "test",
		Build:    &runtime.BuildOutput{Out: out, Handler: "index.handler"},
		Env:      []string{"PATH=" + os.Getenv("PATH")},
	})
	if err != nil {
		t.Fatal(err)
	}
	w := worker.(*Worker)
	t.Cleanup(func() { w.cmd.Process.Kill() })
	return w
}

// openPipes counts the pipes this test process has open. Pipes, not all its
// files, as the stand-in for the runtime API listens on a socket of its own.
func openPipes(t *testing.T) int {
	t.Helper()
	out, err := exec.Command("lsof", "-p", strconv.Itoa(os.Getpid())).Output()
	if err != nil {
		t.Skip("can't count open files: " + err.Error())
	}
	pipes := 0
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		// the type is PIPE on macOS, FIFO on Linux
		if len(fields) > 4 && (fields[4] == "PIPE" || fields[4] == "FIFO") {
			pipes++
		}
	}
	return pipes
}

func processState(pid int) string {
	out, _ := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	return strings.TrimSpace(string(out))
}

// A worker exits on its own, after a minute without work or when its handler
// fails to load. sst dev notices from its output closing, and never waits for
// the process, so it's left a zombie, holding its two pipes open. Every
// worker that exits leaves one, for as long as sst dev runs.
func TestWorkerThatExitsIsCleanedUp(t *testing.T) {
	before := openPipes(t)
	w := startWorker(t, `throw new Error("the handler fails to load")`)
	pid := w.cmd.Process.Pid
	// read the output to the end, as sst dev does to tell the worker exited
	io.Copy(io.Discard, w.Logs())
	time.Sleep(500 * time.Millisecond)

	if state := processState(pid); strings.HasPrefix(state, "Z") {
		t.Errorf("the worker that exited is a zombie (ps stat %q)", state)
	}
	if after := openPipes(t); after > before {
		t.Errorf("%d more pipes are open after the worker exited, want none", after-before)
	}
}

// Stopping a worker, as a rebuild does, signals its process group. The worker
// isn't started in a group of its own, so a process its handler started is
// left running after every rebuild.
func TestStoppingAWorkerStopsWhatItStarted(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	w := startWorker(t, `
import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn("sleep", ["300"], { stdio: "ignore" });
fs.writeFileSync(`+strconv.Quote(pidFile)+`, String(child.pid));
export const handler = async () => "ok";
`)
	go io.Copy(io.Discard, w.Logs())
	var child int
	for deadline := time.Now().Add(10 * time.Second); child == 0; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the handler never started its process")
		}
		data, _ := os.ReadFile(pidFile)
		child, _ = strconv.Atoi(strings.TrimSpace(string(data)))
	}
	t.Cleanup(func() { syscall.Kill(child, syscall.SIGKILL) })

	w.Stop()
	time.Sleep(500 * time.Millisecond)
	if err := syscall.Kill(child, 0); err == nil {
		t.Errorf("the process the handler started (pid %d) still runs after the worker stopped", child)
	}
}

// Stopping a worker waits for it to exit, up to 5 seconds after SIGTERM and 5
// more after SIGKILL. A rebuild stops a function's workers one at a time in
// the loop that answers the bridges, so one that doesn't exit on SIGTERM holds
// up every invocation for 5 seconds each.
func TestStoppingAWorkerDoesNotWaitForIt(t *testing.T) {
	w := startWorker(t, `
process.on("SIGTERM", () => {});
export const handler = async () => "ok";
`)
	logs := bufio.NewReader(w.Logs())
	go io.Copy(io.Discard, logs)
	// let the handler load and register its SIGTERM handler
	time.Sleep(time.Second)

	start := time.Now()
	w.Stop()
	if took := time.Since(start); took > time.Second {
		t.Errorf("Stop took %v, want it to return at once", took.Round(100*time.Millisecond))
	}
}
