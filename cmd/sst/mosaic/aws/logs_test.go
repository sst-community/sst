package aws

import (
	"slices"
	"strings"
	"testing"
)

// What a worker printed is handed over once, in order, and kept apart from
// other workers' lines.
func TestPendingLogsTakeOnce(t *testing.T) {
	logs := newPendingLogs()
	logs.add("w1", "one")
	logs.add("w2", "other")
	logs.add("w1", "two")
	lines, dropped := logs.take("w1")
	if !slices.Equal(lines, []string{"one", "two"}) || dropped != 0 {
		t.Fatalf("took %v with %d dropped, want [one two] and 0", lines, dropped)
	}
	if lines, _ := logs.take("w1"); len(lines) != 0 {
		t.Fatalf("took %v a second time, want nothing", lines)
	}
	if lines, _ := logs.take("w2"); !slices.Equal(lines, []string{"other"}) {
		t.Fatalf("took %v for w2, want [other]", lines)
	}
}

// Past the limit, lines are counted and left out, and the next reply starts
// again from nothing.
func TestPendingLogsLimit(t *testing.T) {
	logs := newPendingLogs()
	line := strings.Repeat("x", 1024)
	for range 300 {
		logs.add("w1", line)
	}
	lines, dropped := logs.take("w1")
	if len(lines) != 256 || dropped != 44 {
		t.Fatalf("kept %d lines and dropped %d, want 256 and 44", len(lines), dropped)
	}
	logs.add("w1", "after")
	if lines, dropped := logs.take("w1"); !slices.Equal(lines, []string{"after"}) || dropped != 0 {
		t.Fatalf("took %v with %d dropped after the limit, want [after] and 0", lines, dropped)
	}
}
