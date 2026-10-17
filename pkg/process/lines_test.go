package process

import (
	"slices"
	"strings"
	"testing"
)

func readAll(t *testing.T, input string, max int) ([]string, int) {
	t.Helper()
	var lines []string
	tooLong := 0
	err := ReadLines(strings.NewReader(input), max, func(line string) {
		lines = append(lines, line)
	}, func() {
		tooLong++
	})
	if err != nil {
		t.Fatal(err)
	}
	return lines, tooLong
}

// The last line counts without a newline after it.
func TestReadLines(t *testing.T) {
	lines, tooLong := readAll(t, "one\ntwo\r\nthree", 100)
	if !slices.Equal(lines, []string{"one", "two", "three"}) || tooLong != 0 {
		t.Fatalf("read %q with %d too long, want [one two three] and 0", lines, tooLong)
	}
}

// A line over the limit is left out, once, and the lines after it still come,
// past bufio's own buffer of 4 KB and bufio.Scanner's limit of 64 KB.
func TestReadLinesPastALongLine(t *testing.T) {
	long := strings.Repeat("x", 100*1024)
	lines, tooLong := readAll(t, "before\n"+long+"\nafter\n", 64*1024)
	if !slices.Equal(lines, []string{"before", "after"}) || tooLong != 1 {
		t.Fatalf("read %d lines with %d too long, want [before after] and 1", len(lines), tooLong)
	}
}

// A line as long as the limit is passed on whole.
func TestReadLinesUpToTheLimit(t *testing.T) {
	long := strings.Repeat("y", 100*1024)
	lines, tooLong := readAll(t, long+"\n", len(long))
	if len(lines) != 1 || lines[0] != long || tooLong != 0 {
		t.Fatalf("read %d lines with %d too long, want the line whole and 0", len(lines), tooLong)
	}
}
