package aws

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
)

// logFiles lists the log files of a function, by name.
func logFiles(t *testing.T, dir, functionID string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, functionID))
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func readLog(t *testing.T, dir, functionID, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, functionID, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestInvocationLogsWriteAnInvocation(t *testing.T) {
	dir := t.TempDir()
	logs := newInvocationLogs(dir, 10)
	logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r1", Input: []byte(`{"a":1}`)})
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", RequestID: "r1", Line: "hello"})
	logs.handle(&FunctionResponseEvent{FunctionID: "Fn", RequestID: "r1", Output: []byte(`"ok"`)})

	files := logFiles(t, dir, "Fn")
	if len(files) != 1 || !strings.HasSuffix(files[0], "-r1.log") {
		t.Fatalf("files %v, want one for r1", files)
	}
	want := "invocation r1\n{\"a\":1}\nhello\nresponse r1\n\"ok\"\n"
	if got := readLog(t, dir, "Fn", files[0]); got != want {
		t.Fatalf("log is %q, want %q", got, want)
	}
	if len(logs.open) != 0 {
		t.Fatalf("%d files still open after the response, want 0", len(logs.open))
	}
}

func TestInvocationLogsCloseOnError(t *testing.T) {
	dir := t.TempDir()
	logs := newInvocationLogs(dir, 10)
	logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r1"})
	logs.handle(&FunctionErrorEvent{FunctionID: "Fn", RequestID: "r1", ErrorType: "Error", ErrorMessage: "boom"})
	if len(logs.open) != 0 {
		t.Fatalf("%d files still open after the error, want 0", len(logs.open))
	}
	files := logFiles(t, dir, "Fn")
	if got := readLog(t, dir, "Fn", files[0]); !strings.HasSuffix(got, "Error: boom\n") {
		t.Fatalf("log is %q, want it to end with the error", got)
	}
}

// What a function prints after its response, as from a promise it didn't wait
// for, goes in the same file, which isn't left open.
func TestInvocationLogsAddLateOutput(t *testing.T) {
	dir := t.TempDir()
	logs := newInvocationLogs(dir, 10)
	logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r1"})
	logs.handle(&FunctionResponseEvent{FunctionID: "Fn", RequestID: "r1"})
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", RequestID: "r1", Line: "late"})

	files := logFiles(t, dir, "Fn")
	if len(files) != 1 {
		t.Fatalf("files %v, want one", files)
	}
	if got := readLog(t, dir, "Fn", files[0]); !strings.HasSuffix(got, "late\n") {
		t.Fatalf("log is %q, want it to end with the late line", got)
	}
	if len(logs.open) != 0 {
		t.Fatalf("%d files open, want 0", len(logs.open))
	}
}

// Only the newest logs of a function are kept, those of an earlier sst dev
// counted, and the logs of other functions aren't touched.
func TestInvocationLogsKeepTheNewest(t *testing.T) {
	dir := t.TempDir()
	for _, path := range []string{"Fn/1000-old1.log", "Fn/1001-old2.log", "Fn/1002-old3.log", "Other/1000-other.log"} {
		os.MkdirAll(filepath.Dir(filepath.Join(dir, path)), 0755)
		if err := os.WriteFile(filepath.Join(dir, path), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	logs := newInvocationLogs(dir, 3)

	logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r1"})
	logs.handle(&FunctionResponseEvent{FunctionID: "Fn", RequestID: "r1"})
	files := logFiles(t, dir, "Fn")
	if len(files) != 3 || slices.Contains(files, "1000-old1.log") || !slices.Contains(files, "1001-old2.log") {
		t.Fatalf("files %v, want the oldest of the earlier logs removed", files)
	}

	for _, id := range []string{"r2", "r3", "r4"} {
		logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: id})
		logs.handle(&FunctionResponseEvent{FunctionID: "Fn", RequestID: id})
	}
	files = logFiles(t, dir, "Fn")
	if len(files) != 3 {
		t.Fatalf("files %v, want 3", files)
	}
	for i, id := range []string{"r2", "r3", "r4"} {
		if !strings.HasSuffix(files[i], "-"+id+".log") {
			t.Fatalf("files %v, want the logs of r2, r3 and r4", files)
		}
	}
	if files := logFiles(t, dir, "Other"); len(files) != 1 {
		t.Fatalf("another function's files %v, want them left alone", files)
	}

	// a request whose log was removed gets a new one
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", RequestID: "r1", Line: "late"})
	files = logFiles(t, dir, "Fn")
	has := func(id string) bool {
		return slices.ContainsFunc(files, func(name string) bool { return strings.HasSuffix(name, "-"+id+".log") })
	}
	if len(files) != 3 || !has("r1") || has("r2") || !has("r3") || !has("r4") {
		t.Fatalf("files %v, want a new log for r1 in place of r2's", files)
	}
}

// The logs are in .sst/log/lambda, where sst dev wrote them before, so the
// ones from earlier sessions are counted.
func TestInvocationLogsDir(t *testing.T) {
	if got, want := invocationLogsDir(&project.Project{}), filepath.Join(".sst", "log", "lambda"); got != want {
		t.Fatalf("invocationLogsDir() = %q, want %q", got, want)
	}
}

// Output that's not part of an invocation, as a worker's before its first one,
// isn't kept open, as it has no response to close it.
func TestInvocationLogsCloseOutputOutsideAnInvocation(t *testing.T) {
	dir := t.TempDir()
	logs := newInvocationLogs(dir, 10)
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", Line: "starting"})
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", Line: "ready"})
	if len(logs.open) != 0 {
		t.Fatalf("%d files open, want 0", len(logs.open))
	}
	files := logFiles(t, dir, "Fn")
	if len(files) != 1 {
		t.Fatalf("files %v, want one", files)
	}
	if got := readLog(t, dir, "Fn", files[0]); got != "starting\nready\n" {
		t.Fatalf("log is %q, want both lines", got)
	}
}

// A function's output that's not part of an invocation goes in a log of that
// function, not of whichever function printed first.
func TestInvocationLogsKeepFunctionsApart(t *testing.T) {
	dir := t.TempDir()
	logs := newInvocationLogs(dir, 10)
	logs.handle(&FunctionLogEvent{FunctionID: "A", Line: "from a"})
	logs.handle(&FunctionLogEvent{FunctionID: "B", Line: "from b"})
	for _, fn := range []string{"A", "B"} {
		files := logFiles(t, dir, fn)
		if len(files) != 1 {
			t.Fatalf("%s files %v, want one", fn, files)
		}
		if got, want := readLog(t, dir, fn, files[0]), "from "+strings.ToLower(fn)+"\n"; got != want {
			t.Fatalf("%s log is %q, want %q", fn, got, want)
		}
	}
}

// logInvocations writes every event it gets, the first included, and stops
// with its context.
func TestLogInvocations(t *testing.T) {
	dir := t.TempDir()
	subscribers := func() int {
		n := 0
		for _, stat := range bus.Stats() {
			if strings.Contains(stat.Label, "aws.FunctionLogEvent") {
				n++
			}
		}
		return n
	}
	before := subscribers()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		logInvocations(ctx, dir)
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for subscribers() == before {
		if time.Now().After(deadline) {
			t.Fatal("logInvocations never subscribed")
		}
		time.Sleep(time.Millisecond)
	}

	bus.Publish(&FunctionInvokedEvent{FunctionID: "Logged", RequestID: "r1", Input: []byte("in")})
	bus.Publish(&FunctionResponseEvent{FunctionID: "Logged", RequestID: "r1", Output: []byte("out")})
	want := "invocation r1\nin\nresponse r1\nout\n"
	deadline = time.Now().Add(5 * time.Second)
	for {
		files, _ := os.ReadDir(filepath.Join(dir, "Logged"))
		if len(files) == 1 {
			if got := readLog(t, dir, "Logged", files[0].Name()); got == want {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("log of r1 never had %q", want)
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("logInvocations didn't stop with its context")
	}
	if subscribers() != before {
		t.Fatal("logInvocations is still subscribed after it stopped")
	}
}
