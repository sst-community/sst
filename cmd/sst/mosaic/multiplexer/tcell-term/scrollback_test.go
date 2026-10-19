package tcellterm

import (
	"fmt"
	"runtime"
	"strings"
	"testing"

	"github.com/gdamore/tcell/v2"
)

// A pane in sst dev's multiplexer keeps every line that scrolls off its screen.
// Each line is a row of cells, about 100 bytes a cell, so a few hundred thousand
// lines of function output in a long session hold gigabytes. The scrollback has
// to be capped.
func TestScrollbackIsCapped(t *testing.T) {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	vt := New()
	vt.Resize(200, 40)
	for i := range 50_000 {
		for _, r := range fmt.Sprintf("invocation %d printed a line", i) {
			vt.print(r)
		}
		vt.c0('\r')
		vt.c0('\n')
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	held := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	if got, limit := len(vt.primaryScrollback), 10_000; got > limit {
		t.Fatalf("scrollback holds %d lines (%d MB) after 50,000, want at most %d", got, held>>20, limit)
	}
}

// printLines prints lines to a pane, as a function's output does.
func printLines(vt *VT, from, to int) {
	for i := from; i < to; i++ {
		for _, r := range fmt.Sprintf("line %d", i) {
			vt.print(r)
		}
		vt.c0('\r')
		vt.c0('\n')
	}
}

// The lines kept are the latest, and they don't keep the blank cells at their
// end, so 10,000 short lines in a wide pane hold a few MB, not hundreds.
func TestScrollbackKeepsTheLatestLines(t *testing.T) {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	vt := New()
	vt.Resize(200, 2)
	printLines(vt, 0, maxScrollback+5_000)
	runtime.GC()
	runtime.ReadMemStats(&after)
	if got := len(vt.primaryScrollback); got != maxScrollback {
		t.Fatalf("scrollback holds %d lines, want %d", got, maxScrollback)
	}
	if got, want := rowText(vt.primaryScrollback[0]), fmt.Sprintf("line %d", 5_000-1); got != want {
		t.Fatalf("the oldest line kept is %q, want %q", got, want)
	}
	if held, limit := int64(after.HeapAlloc)-int64(before.HeapAlloc), int64(30<<20); held > limit {
		t.Fatalf("%d short lines hold %d MB, want under %d MB", maxScrollback, held>>20, limit>>20)
	}
}

// Scrolled up, a pane goes on showing the same lines as the oldest are dropped.
func TestScrollbackStaysPutWhenLinesAreDropped(t *testing.T) {
	vt := New()
	vt.Resize(20, 2)
	printLines(vt, 0, maxScrollback)
	vt.ScrollUp(100)
	shown := rowText(vt.primaryScrollback[vt.scroll])
	printLines(vt, maxScrollback, maxScrollback+50)
	if got := rowText(vt.primaryScrollback[vt.scroll]); got != shown {
		t.Fatalf("scrolled up to %q, the pane shows %q after more lines", shown, got)
	}
}

type surface struct {
	w, h  int
	cells map[[2]int]rune
}

func (s *surface) SetContent(x int, y int, ch rune, comb []rune, style tcell.Style) {
	s.cells[[2]int{x, y}] = ch
}

func (s *surface) Size() (int, int) { return s.w, s.h }

// A line from the scrollback is drawn across the pane, blank after its text, so
// nothing drawn there before shows through.
func TestScrollbackLinesAreDrawnAcross(t *testing.T) {
	vt := New()
	vt.Resize(20, 2)
	printLines(vt, 0, 10)
	srf := &surface{w: 20, h: 2, cells: map[[2]int]rune{}}
	for x := range 20 {
		srf.cells[[2]int{x, 0}] = '#'
	}
	vt.SetSurface(srf)
	vt.ScrollUp(5)
	vt.Draw()
	for x := len("line 0"); x < 20; x++ {
		if got := srf.cells[[2]int{x, 0}]; got != ' ' {
			t.Fatalf("column %d of a line from the scrollback shows %q, want it blank", x, got)
		}
	}
}

func rowText(row []cell) string {
	text := []rune{}
	for _, c := range row {
		text = append(text, c.rune())
	}
	return strings.TrimRight(string(text), " ")
}
