package aws

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
)

// testInvocationLogs writes to a temporary folder, at a fixed time, with no
// total.
func testInvocationLogs(t *testing.T, limit int64) (*invocationLogs, string) {
	t.Helper()
	dir := t.TempDir()
	return logsIn(t, dir, limit, 1<<40), dir
}

func logsIn(t *testing.T, dir string, limit, total int64) *invocationLogs {
	t.Helper()
	logs := newInvocationLogs(dir, limit, total)
	logs.now = func() time.Time { return time.Date(2026, 11, 16, 12, 0, 0, 123e6, time.UTC) }
	t.Cleanup(logs.close)
	return logs
}

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
}

func size(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

func readLog(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func entries(t *testing.T, dir string) []string {
	t.Helper()
	list, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range list {
		names = append(names, entry.Name())
	}
	return names
}

func invoke(logs *invocationLogs, functionID, requestID string) {
	logs.handle(&FunctionInvokedEvent{FunctionID: functionID, RequestID: requestID, Input: []byte(`{}`)})
	logs.handle(&FunctionLogEvent{FunctionID: functionID, RequestID: requestID, Line: "working on " + requestID})
	logs.handle(&FunctionResponseEvent{FunctionID: functionID, RequestID: requestID, Output: []byte(`"ok"`)})
}

const at = "2026-11-16T12:00:00.123Z "

func TestInvocationLogsWriteAnInvocation(t *testing.T) {
	logs, dir := testInvocationLogs(t, 1<<20)
	logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r1", Input: []byte(`{"a":1}`)})
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", RequestID: "r1", Line: "hello"})
	logs.handle(&FunctionResponseEvent{FunctionID: "Fn", RequestID: "r1", Output: []byte(`"ok"`)})

	want := at + "r1 invoked {\"a\":1}\n" + at + "r1 | hello\n" + at + "r1 responded \"ok\"\n"
	if got := readLog(t, filepath.Join(dir, "Fn.log")); got != want {
		t.Fatalf("log is %q, want %q", got, want)
	}
}

// Invocations that run at once write to the same log, and each of their lines
// says which it's from, so grep finds all of one.
func TestInvocationLogsTagEachLine(t *testing.T) {
	logs, dir := testInvocationLogs(t, 1<<20)
	logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r1"})
	logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r2"})
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", RequestID: "r2", Line: "two"})
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", RequestID: "r1", Line: "one"})
	logs.handle(&FunctionResponseEvent{FunctionID: "Fn", RequestID: "r1", Output: []byte("{\n  \"a\": 1\n}\n")})

	want := at + "r1 invoked\n" +
		at + "r2 invoked\n" +
		at + "r2 | two\n" +
		at + "r1 | one\n" +
		at + "r1 responded {\n" +
		at + "r1 responded   \"a\": 1\n" +
		at + "r1 responded }\n"
	if got := readLog(t, filepath.Join(dir, "Fn.log")); got != want {
		t.Fatalf("log is %q, want %q", got, want)
	}
}

func TestInvocationLogsWriteAnError(t *testing.T) {
	logs, dir := testInvocationLogs(t, 1<<20)
	logs.handle(&FunctionErrorEvent{FunctionID: "Fn", RequestID: "r1", ErrorType: "Error", ErrorMessage: "boom", Trace: []string{"Error: boom", "at a", "at b"}})
	logs.handle(&FunctionErrorEvent{FunctionID: "Fn", ErrorMessage: "Function failed to build"})
	// a message of more than one line isn't repeated by the trace either
	logs.handle(&FunctionErrorEvent{FunctionID: "Fn", RequestID: "r2", ErrorType: "Error", ErrorMessage: "two\nlines", Trace: []string{"Error: two", "lines", "at c"}})
	want := at + "r1 failed Error: boom\n" + at + "r1 failed at a\n" + at + "r1 failed at b\n" + at + "- failed Function failed to build\n" +
		at + "r2 failed Error: two\n" + at + "r2 failed lines\n" + at + "r2 failed at c\n"
	if got := readLog(t, filepath.Join(dir, "Fn.log")); got != want {
		t.Fatalf("log is %q, want %q", got, want)
	}
}

// What a function prints after its response, as from a promise it didn't wait
// for, is under the same request ID, and what it prints outside an invocation,
// as a worker before its first, under -.
func TestInvocationLogsLateAndUnattachedOutput(t *testing.T) {
	logs, dir := testInvocationLogs(t, 1<<20)
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", Line: "starting"})
	logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r1"})
	logs.handle(&FunctionResponseEvent{FunctionID: "Fn", RequestID: "r1"})
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", RequestID: "r1", Line: "late"})

	want := at + "- | starting\n" + at + "r1 invoked\n" + at + "r1 responded\n" + at + "r1 | late\n"
	if got := readLog(t, filepath.Join(dir, "Fn.log")); got != want {
		t.Fatalf("log is %q, want %q", got, want)
	}
}

func TestInvocationLogsKeepFunctionsApart(t *testing.T) {
	logs, dir := testInvocationLogs(t, 1<<20)
	logs.handle(&FunctionLogEvent{FunctionID: "A", Line: "from a"})
	logs.handle(&FunctionLogEvent{FunctionID: "B", Line: "from b"})
	for _, fn := range []string{"A", "B"} {
		if got, want := readLog(t, filepath.Join(dir, fn+".log")), at+"- | from "+strings.ToLower(fn)+"\n"; got != want {
			t.Fatalf("%s log is %q, want %q", fn, got, want)
		}
	}
}

// A separator in a function's ID doesn't put its log in a folder, which the
// next sst dev would remove as an old one, and IDs that differ only there
// don't share a log.
func TestInvocationLogsSeparatorInFunctionID(t *testing.T) {
	logs, dir := testInvocationLogs(t, 1<<20)
	for _, id := range []string{`a/b\c`, "a_b_c", "a%2Fb", "x:y"} {
		logs.handle(&FunctionLogEvent{FunctionID: id, Line: id})
	}
	want := []string{"a%252Fb.log", "a%2Fb%5Cc.log", "a_b_c.log", "x%3Ay.log"}
	if got := entries(t, dir); !slices.Equal(got, want) {
		t.Fatalf("entries %v, want %v", got, want)
	}
	if got := readLog(t, filepath.Join(dir, "a_b_c.log")); got != at+"- | a_b_c\n" {
		t.Fatalf("a_b_c.log is %q, want only its own line", got)
	}
}

// An event bigger than the limit, as a big payload, is moved to .log.1 on its
// own, so .log keeps to the limit.
func TestInvocationLogsRotateABigEvent(t *testing.T) {
	logs, dir := testInvocationLogs(t, 100)
	logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r1", Input: []byte(strings.Repeat("x", 500))})
	logs.handle(&FunctionResponseEvent{FunctionID: "Fn", RequestID: "r1"})
	if got := size(t, filepath.Join(dir, "Fn.log.1")); got < 500 {
		t.Fatalf("Fn.log.1 is %d bytes, want the big event", got)
	}
	if got := readLog(t, filepath.Join(dir, "Fn.log")); got != at+"r1 responded\n" {
		t.Fatalf("Fn.log is %q, want only the response", got)
	}

	// at a log that's nearly full, the big event is moved with what was
	// there, not on its own over the .log.1 that was just made
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", RequestID: "r2", Line: "kept"})
	logs.handle(&FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r3", Input: []byte(strings.Repeat("y", 500))})
	old := readLog(t, filepath.Join(dir, "Fn.log.1"))
	if !strings.Contains(old, " r2 | kept\n") || !strings.Contains(old, strings.Repeat("y", 500)) {
		t.Fatalf("Fn.log.1 is %q, want r2's line and the big event", old)
	}
}

// #279: a busy function's history is kept by size, not by how many times it
// ran, so its logs from a few minutes ago aren't gone after 100 invocations.
func TestInvocationLogsKeepABusyFunctionsHistory(t *testing.T) {
	logs, dir := testInvocationLogs(t, 10<<20)
	for i := range 1_000 {
		invoke(logs, "Busy", fmt.Sprintf("r%d", i))
	}
	got := readLog(t, filepath.Join(dir, "Busy.log"))
	for _, id := range []string{"r0", "r500", "r999"} {
		if !strings.Contains(got, " "+id+" | working on "+id+"\n") {
			t.Fatalf("log has no line of %s after 1,000 invocations", id)
		}
	}
}

// #279: an invocation adds to its function's one log, with no file made or
// removed for it, so the folder doesn't grow with the number of invocations.
func TestInvocationLogsOneFileForEachFunction(t *testing.T) {
	logs, dir := testInvocationLogs(t, 10<<20)
	for i := range 1_000 {
		invoke(logs, "Busy", fmt.Sprintf("r%d", i))
		invoke(logs, "Other", fmt.Sprintf("o%d", i))
	}
	if got := entries(t, dir); len(got) != 2 || got[0] != "Busy.log" || got[1] != "Other.log" {
		t.Fatalf("entries %v, want Busy.log and Other.log", got)
	}
	if len(logs.open) != 2 {
		t.Fatalf("%d logs open, want 2", len(logs.open))
	}
}

// Past its limit, a log is moved to .log.1, replacing an older one, so a
// function never keeps more than twice the limit, and the newest lines are in
// .log.
func TestInvocationLogsRotate(t *testing.T) {
	const limit = 4 << 10
	logs, dir := testInvocationLogs(t, limit)
	last := ""
	for i := range 500 {
		last = fmt.Sprintf("r%d", i)
		invoke(logs, "Fn", last)
	}
	if got := entries(t, dir); len(got) != 2 || got[0] != "Fn.log" || got[1] != "Fn.log.1" {
		t.Fatalf("entries %v, want Fn.log and Fn.log.1", got)
	}
	for _, name := range []string{"Fn.log", "Fn.log.1"} {
		if got := size(t, filepath.Join(dir, name)); got > limit {
			t.Fatalf("%s is %d bytes, past the limit of %d", name, got, limit)
		}
	}
	current := readLog(t, filepath.Join(dir, "Fn.log"))
	if !strings.HasSuffix(current, at+last+" responded \"ok\"\n") {
		t.Fatalf("Fn.log ends %q, want the newest invocation", current[max(0, len(current)-80):])
	}
	if strings.Contains(readLog(t, filepath.Join(dir, "Fn.log.1")), " r0 ") {
		t.Fatal("Fn.log.1 still has r0, want it replaced by a newer one")
	}
}

// A log from an earlier sst dev is added to, and its size counted toward the
// limit.
func TestInvocationLogsAddToAnEarlierLog(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "Fn.log"), strings.Repeat("x", 90)+"\n")
	logs := logsIn(t, dir, 100, 1<<40)
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", RequestID: "r1", Line: "new"})
	if got := readLog(t, filepath.Join(dir, "Fn.log")); got != at+"r1 | new\n" {
		t.Fatalf("Fn.log is %q, want only the new line", got)
	}
	if got := readLog(t, filepath.Join(dir, "Fn.log.1")); got != strings.Repeat("x", 90)+"\n" {
		t.Fatalf("Fn.log.1 is %q, want the earlier log", got)
	}
}

// Past the total, the oldest .log.1 files are removed first, those of an
// earlier sst dev included, and the current logs are left.
func TestInvocationLogsTotalRemovesTheOldestFirst(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "Old.log.1"), strings.Repeat("x", 999)+"\n")
	tick := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	past := tick.Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "Old.log.1"), past, past); err != nil {
		t.Fatal(err)
	}
	logs := logsIn(t, dir, 1000, 2500)
	logs.now = func() time.Time { tick = tick.Add(time.Second); return tick }
	// A and then B fill and rotate, which takes the total past 2,500
	for _, fn := range []string{"A", "B"} {
		for i := 0; size0(dir, fn+".log.1") == 0; i++ {
			invoke(logs, fn, fmt.Sprintf("%s%d", fn, i))
		}
	}
	got := entries(t, dir)
	if slices.Contains(got, "Old.log.1") {
		t.Fatalf("entries %v, want the earlier sst dev's Old.log.1 removed first", got)
	}
	for _, name := range []string{"A.log", "B.log", "B.log.1"} {
		if !slices.Contains(got, name) {
			t.Fatalf("entries %v, want %s kept", got, name)
		}
	}
	if logs.size > 2500 {
		t.Fatalf("logs take %d bytes, past the total of 2500", logs.size)
	}
}

// With hundreds of functions, all the logs stay under the total, and what's
// counted is what's on disk.
func TestInvocationLogsTotalWithManyFunctions(t *testing.T) {
	const limit, total = 2 << 10, 64 << 10
	dir := t.TempDir()
	logs := logsIn(t, dir, limit, total)
	for i := range 20 {
		for fn := range 300 {
			invoke(logs, fmt.Sprintf("Fn%d", fn), fmt.Sprintf("r%d", i))
		}
	}
	var onDisk int64
	for _, name := range entries(t, dir) {
		onDisk += size(t, filepath.Join(dir, name))
	}
	if onDisk > total {
		t.Fatalf("logs take %d bytes on disk, past the total of %d", onDisk, total)
	}
	if onDisk != logs.size {
		t.Fatalf("logs take %d bytes on disk, but %d are counted", onDisk, logs.size)
	}
	// what's removed is the oldest: the functions written last keep their
	// newest invocation, and the first ones are gone
	for fn := 290; fn < 300; fn++ {
		name := fmt.Sprintf("Fn%d.log", fn)
		if got := readLog(t, filepath.Join(dir, name)); !strings.Contains(got, " r19 responded") {
			t.Fatalf("%s is %q, want its newest invocation", name, got)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "Fn0.log")); !os.IsNotExist(err) {
		t.Fatalf("Fn0.log, written longest ago, is still there (%v)", err)
	}
}

// With hundreds of functions, only maxOpenInvocationLogs of their logs are
// open at once, and a log that was closed is added to when it's opened again.
func TestInvocationLogsLimitOpenFiles(t *testing.T) {
	logs, dir := testInvocationLogs(t, 10<<20)
	for fn := range 300 {
		invoke(logs, fmt.Sprintf("Fn%d", fn), "r1")
	}
	if len(logs.open) != maxOpenInvocationLogs {
		t.Fatalf("%d logs open, want %d", len(logs.open), maxOpenInvocationLogs)
	}
	if _, ok := logs.open[filepath.Join(dir, "Fn299.log")]; !ok {
		t.Fatal("the log written last isn't open")
	}
	invoke(logs, "Fn0", "r2")
	got := readLog(t, filepath.Join(dir, "Fn0.log"))
	if !strings.Contains(got, " r1 responded") || !strings.Contains(got, " r2 responded") {
		t.Fatalf("Fn0.log is %q, want both invocations", got)
	}
}

// A log that's removed or moved while sst dev runs, as with rm, is made again
// within a second, and its size counted from 0.
func TestInvocationLogsReopenARemovedLog(t *testing.T) {
	logs, dir := testInvocationLogs(t, 10<<20)
	tick := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	logs.now = func() time.Time { return tick }
	invoke(logs, "Fn", "r1")
	if err := os.Remove(filepath.Join(dir, "Fn.log")); err != nil {
		t.Fatal(err)
	}
	tick = tick.Add(time.Second)
	invoke(logs, "Fn", "r2")
	got := readLog(t, filepath.Join(dir, "Fn.log"))
	if strings.Contains(got, " r1 ") || !strings.Contains(got, " r2 responded") {
		t.Fatalf("Fn.log is %q, want only r2", got)
	}
	if logs.size != int64(len(got)) {
		t.Fatalf("logs take %d bytes, but %d are counted", len(got), logs.size)
	}

	// moved, as by a tool that rotates logs
	if err := os.Rename(filepath.Join(dir, "Fn.log"), filepath.Join(dir, "moved")); err != nil {
		t.Fatal(err)
	}
	tick = tick.Add(time.Second)
	invoke(logs, "Fn", "r3")
	if got := readLog(t, filepath.Join(dir, "Fn.log")); !strings.Contains(got, " r3 responded") || strings.Contains(got, " r2 ") {
		t.Fatalf("Fn.log is %q, want only r3", got)
	}

	// emptied in place, as with > Fn.log, which keeps the same file
	if err := os.Truncate(filepath.Join(dir, "Fn.log"), 0); err != nil {
		t.Fatal(err)
	}
	tick = tick.Add(time.Second)
	invoke(logs, "Fn", "r3b")
	if got := readLog(t, filepath.Join(dir, "Fn.log")); logs.sizes[filepath.Join(dir, "Fn.log")] != int64(len(got)) {
		t.Fatalf("Fn.log is %d bytes, but %d are counted", len(got), logs.sizes[filepath.Join(dir, "Fn.log")])
	}

	// moved to Fn.log.1, as by a tool that rotates logs, which is counted
	// toward the total from what's on disk
	if err := os.Rename(filepath.Join(dir, "Fn.log"), filepath.Join(dir, "Fn.log.1")); err != nil {
		t.Fatal(err)
	}
	tick = tick.Add(time.Second)
	invoke(logs, "Fn", "r4")
	var onDisk int64
	for _, name := range entries(t, dir) {
		// moved above, and not a log
		if name != "moved" {
			onDisk += size(t, filepath.Join(dir, name))
		}
	}
	if logs.size != onDisk {
		t.Fatalf("logs take %d bytes on disk, but %d are counted", onDisk, logs.size)
	}
	if _, ok := logs.rotated[filepath.Join(dir, "Fn.log.1")]; !ok {
		t.Fatal("Fn.log.1 isn't counted as a rotated log, to be removed first")
	}
}

func size0(dir, name string) int64 {
	info, err := os.Stat(filepath.Join(dir, name))
	if err != nil {
		return 0
	}
	return info.Size()
}

// Two IDs that differ only in case don't share a log, on a disk that ignores
// case as macOS's does by default, and each keeps its log while sst dev runs.
func TestInvocationLogsIDsThatDifferOnlyInCase(t *testing.T) {
	logs, dir := testInvocationLogs(t, 1<<20)
	logs.handle(&FunctionLogEvent{FunctionID: "MyFn", Line: "upper"})
	logs.handle(&FunctionLogEvent{FunctionID: "myfn", Line: "lower"})
	logs.handle(&FunctionLogEvent{FunctionID: "MyFn", Line: "upper again"})
	got := entries(t, dir)
	if len(got) != 2 || got[0] != "MyFn.log" || !strings.HasPrefix(got[1], "myfn~") {
		t.Fatalf("entries %v, want MyFn.log and myfn~<hash>.log", got)
	}
	if log := readLog(t, filepath.Join(dir, "MyFn.log")); log != at+"- | upper\n"+at+"- | upper again\n" {
		t.Fatalf("MyFn.log is %q, want only MyFn's lines", log)
	}
	if log := readLog(t, filepath.Join(dir, got[1])); log != at+"- | lower\n" {
		t.Fatalf("%s is %q, want only myfn's line", got[1], log)
	}
}

// A log rotated by a tool to .log.2 or further is counted toward the total,
// and removed before the newer .log.1.
func TestInvocationLogsCountOtherRotations(t *testing.T) {
	dir := t.TempDir()
	tick := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	for i, name := range []string{"Fn.log.3", "Fn.log.2"} {
		writeFile(t, filepath.Join(dir, name), strings.Repeat("x", 999)+"\n")
		old := tick.Add(-time.Duration(2-i) * time.Hour)
		if err := os.Chtimes(filepath.Join(dir, name), old, old); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(dir, "Fn.log.backup"), "not a log\n")
	logs := logsIn(t, dir, 1<<20, 2500)
	if logs.size != 2000 {
		t.Fatalf("%d bytes counted, want the 2,000 of Fn.log.2 and Fn.log.3", logs.size)
	}
	logs.now = func() time.Time { return tick }
	logs.handle(&FunctionLogEvent{FunctionID: "Fn", Line: strings.Repeat("y", 600)})
	got := entries(t, dir)
	if !slices.Equal(got, []string{"Fn.log", "Fn.log.2", "Fn.log.backup"}) {
		t.Fatalf("entries %v, want the oldest, Fn.log.3, removed", got)
	}
}

// An ID that differs only in case from a log an earlier sst dev left gets a
// log of its own too, and the function of that log keeps it.
func TestInvocationLogsIDsThatDifferOnlyInCaseAcrossSessions(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "MyFn.log"), "earlier\n")
	logs := logsIn(t, dir, 1<<20, 1<<40)
	logs.handle(&FunctionLogEvent{FunctionID: "myfn", Line: "lower"})
	logs.handle(&FunctionLogEvent{FunctionID: "MyFn", Line: "upper"})
	got := entries(t, dir)
	if len(got) != 2 || got[0] != "MyFn.log" || !strings.HasPrefix(got[1], "myfn~") {
		t.Fatalf("entries %v, want MyFn.log and myfn~<hash>.log", got)
	}
	if log := readLog(t, filepath.Join(dir, "MyFn.log")); log != "earlier\n"+at+"- | upper\n" {
		t.Fatalf("MyFn.log is %q, want only MyFn's lines", log)
	}
}

// A tool that shifts a log's rotations while sst dev runs, .1 to .2 and the
// log to .1, has all of them counted again.
func TestInvocationLogsCountRotationsShiftedWhileRunning(t *testing.T) {
	logs, dir := testInvocationLogs(t, 1<<20)
	tick := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	logs.now = func() time.Time { return tick }
	writeFile(t, filepath.Join(dir, "Fn.log.1"), "older\n")
	logs.recount(filepath.Join(dir, "Fn.log.1"))
	invoke(logs, "Fn", "r1")
	for _, move := range [][2]string{{"Fn.log.1", "Fn.log.2"}, {"Fn.log", "Fn.log.1"}} {
		if err := os.Rename(filepath.Join(dir, move[0]), filepath.Join(dir, move[1])); err != nil {
			t.Fatal(err)
		}
	}
	tick = tick.Add(time.Second)
	invoke(logs, "Fn", "r2")
	var onDisk int64
	for _, name := range entries(t, dir) {
		onDisk += size(t, filepath.Join(dir, name))
	}
	if logs.size != onDisk {
		t.Fatalf("logs take %d bytes on disk, but %d are counted", onDisk, logs.size)
	}
	for _, name := range []string{"Fn.log.1", "Fn.log.2"} {
		if _, ok := logs.rotated[filepath.Join(dir, name)]; !ok {
			t.Fatalf("%s isn't counted as a rotated log", name)
		}
	}
}

// Logs an earlier sst dev left are removed oldest first, by when they were
// last written, not by name.
func TestInvocationLogsTotalRemovesEarlierLogsOldestFirst(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	for i, name := range []string{"B.log", "A.log", "C.log"} {
		writeFile(t, filepath.Join(dir, name), strings.Repeat("x", 999)+"\n")
		at := base.Add(time.Duration(i) * time.Hour)
		if err := os.Chtimes(filepath.Join(dir, name), at, at); err != nil {
			t.Fatal(err)
		}
	}
	logs := logsIn(t, dir, 1<<20, 3000)
	logs.handle(&FunctionLogEvent{FunctionID: "New", Line: "x"})
	if got := entries(t, dir); !slices.Equal(got, []string{"A.log", "C.log", "New.log"}) {
		t.Fatalf("entries %v, want B.log, written longest ago, removed", got)
	}
}

// With a total smaller than one write, the log just written is kept.
func TestInvocationLogsTotalKeepsTheLogJustWritten(t *testing.T) {
	logs, dir := testInvocationLogs(t, 1<<20)
	logs.total = 10
	logs.handle(&FunctionLogEvent{FunctionID: "A", Line: "first"})
	logs.handle(&FunctionLogEvent{FunctionID: "B", Line: "second"})
	if got := entries(t, dir); !slices.Equal(got, []string{"B.log"}) {
		t.Fatalf("entries %v, want only B.log, the log just written", got)
	}
	if got := readLog(t, filepath.Join(dir, "B.log")); got != at+"- | second\n" {
		t.Fatalf("B.log is %q, want its line", got)
	}
}

// #279: the folders of an earlier sst dev, a file for each invocation, are
// removed, and the logs of this one are left.
func TestRemoveInvocationFolders(t *testing.T) {
	dir := t.TempDir()
	for _, path := range []string{"Fn/1794900000-r1.log", "Fn/1794900001-r2.log", "Other/1794900000-r3.log", "Fn.log", "Fn.log.1"} {
		os.MkdirAll(filepath.Dir(filepath.Join(dir, path)), 0755)
		if err := os.WriteFile(filepath.Join(dir, path), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	// a folder with anything else in it was put there for something else
	os.MkdirAll(filepath.Join(dir, "Mine"), 0755)
	writeFile(t, filepath.Join(dir, "Mine", "1794900000-r1.log"), "x")
	writeFile(t, filepath.Join(dir, "Mine", "notes.txt"), "x")
	os.MkdirAll(filepath.Join(dir, "Empty"), 0755)
	// and so was one of date-named logs, which aren't in Unix seconds
	os.MkdirAll(filepath.Join(dir, "Dated"), 0755)
	writeFile(t, filepath.Join(dir, "Dated", "2024-01-01.log"), "x")
	// a symlink to a folder elsewhere is left, and so is what's in it
	elsewhere := t.TempDir()
	writeFile(t, filepath.Join(elsewhere, "keep"), "x")
	if err := os.Symlink(elsewhere, filepath.Join(dir, "Linked")); err != nil {
		t.Fatal(err)
	}
	removeInvocationFolders(dir)
	if got := entries(t, dir); !slices.Equal(got, []string{"Dated", "Empty", "Fn.log", "Fn.log.1", "Linked", "Mine"}) {
		t.Fatalf("entries %v, want Fn and Other removed, and the rest left", got)
	}
	if _, err := os.Stat(filepath.Join(elsewhere, "keep")); err != nil {
		t.Fatalf("what the symlink points to was removed: %v", err)
	}
	// a project that never ran sst dev has no folder
	removeInvocationFolders(filepath.Join(dir, "missing"))
}

func TestInvocationLogsTotal(t *testing.T) {
	for value, want := range map[string]int64{"": defaultInvocationLogsTotal, "200": 200 << 20, "off": defaultInvocationLogsTotal, "-5": defaultInvocationLogsTotal} {
		if got := invocationLogsTotal(value); got != want {
			t.Errorf("invocationLogsTotal(%q) = %d, want %d", value, got, want)
		}
	}
}

func TestInvocationLogLimit(t *testing.T) {
	for _, tc := range []struct {
		value string
		limit int64
		on    bool
	}{
		{"", defaultInvocationLogLimit, true},
		{"off", 0, false},
		{"OFF", 0, false},
		{"false", 0, false},
		{"0", 0, false},
		{"0.0", 0, false},
		{"00", 0, false},
		{"50", 50 << 20, true},
		{" 0.5 ", 512 << 10, true},
		{"lots", defaultInvocationLogLimit, true},
		{"-1", defaultInvocationLogLimit, true},
		{"1048576", 1 << 40, true},
		// would overflow a size in bytes
		{"99999999999999", defaultInvocationLogLimit, true},
		{"+Inf", defaultInvocationLogLimit, true},
		{"NaN", defaultInvocationLogLimit, true},
	} {
		limit, on := invocationLogLimit(tc.value)
		if limit != tc.limit || on != tc.on {
			t.Errorf("invocationLogLimit(%q) = %d, %v, want %d, %v", tc.value, limit, on, tc.limit, tc.on)
		}
	}
}

// The logs are in .sst/log/lambda, where sst dev wrote them before, so the
// old ones are found to remove.
func TestInvocationLogsDir(t *testing.T) {
	if got, want := invocationLogsDir(&project.Project{}), filepath.Join(".sst", "log", "lambda"); got != want {
		t.Fatalf("invocationLogsDir() = %q, want %q", got, want)
	}
}

// logInvocations writes every event it gets, the first included, and stops
// with its context, closing its logs.
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
		logInvocations(ctx, dir, 1<<20, 1<<30)
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
	deadline = time.Now().Add(5 * time.Second)
	for {
		data, _ := os.ReadFile(filepath.Join(dir, "Logged.log"))
		if strings.Contains(string(data), " r1 invoked in\n") && strings.Contains(string(data), " r1 responded out\n") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("log of r1 is %q, want its invocation and response", data)
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

// The cost of an invocation, of a function among 1, 30 or 300, once their
// logs are warm.
func benchLogs(b *testing.B, logs *invocationLogs, functions int) {
	ids := make([]string, functions)
	for i := range ids {
		ids[i] = fmt.Sprintf("Function%d", i)
	}
	run := func(i int) {
		fn, id := ids[i%functions], fmt.Sprintf("req-%d", i)
		logs.handle(&FunctionInvokedEvent{FunctionID: fn, RequestID: id, Input: []byte(`{"path":"/api/items","method":"GET"}`)})
		for j := 0; j < 3; j++ {
			logs.handle(&FunctionLogEvent{FunctionID: fn, RequestID: id, Line: "INFO handling request with some context"})
		}
		logs.handle(&FunctionResponseEvent{FunctionID: fn, RequestID: id, Output: []byte(`{"statusCode":200,"body":"[]"}`)})
	}
	// warm up to the cap: 100 invocations of each function
	for i := 0; i < 100*functions; i++ {
		run(i)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		run(100*functions + i)
	}
}

func BenchmarkInvocationLogs(b *testing.B) {
	for _, f := range []int{1, 30, 300} {
		b.Run(fmt.Sprintf("functions=%d", f), func(b *testing.B) {
			logs := newInvocationLogs(b.TempDir(), defaultInvocationLogLimit, defaultInvocationLogsTotal)
			defer logs.close()
			benchLogs(b, logs, f)
		})
	}
}
