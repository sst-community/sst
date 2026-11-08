package socket

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func invocation(id, source string, input int) *Invocation {
	return &Invocation{
		ID:     id,
		Source: source,
		Input:  json.RawMessage(strings.Repeat("x", input)),
		Errors: []InvocationError{},
		Logs:   []InvocationLog{},
	}
}

func ids(s *invocationStore) []string {
	out := []string{}
	for _, invocation := range s.list() {
		out = append(out, invocation.ID)
	}
	return out
}

func TestStoreKeepsTheNewestInvocations(t *testing.T) {
	s := newInvocationStore()
	for i := range maxInvocations + 5 {
		s.add(invocation(fmt.Sprint(i), "fn", 1))
	}
	got := ids(s)
	if len(got) != maxInvocations {
		t.Fatalf("kept %d invocations, want %d", len(got), maxInvocations)
	}
	if got[0] != "5" || got[len(got)-1] != fmt.Sprint(maxInvocations+4) {
		t.Fatalf("kept %s to %s, want the newest, 5 to %d", got[0], got[len(got)-1], maxInvocations+4)
	}
	if _, ok := s.get("4"); ok {
		t.Fatal("an invocation that was dropped is still found")
	}
}

func TestStoreKeepsItsInputsOutputsAndLogsUnderTheByteLimit(t *testing.T) {
	s := newInvocationStore()
	const mb = 1 << 20
	for i := range 200 {
		id := fmt.Sprint(i)
		s.add(invocation(id, "fn", 1024))
		s.grow(id, mb) // a 1 MB output
		s.log(id, InvocationLog{Message: "done"})
	}
	if s.total > maxInvocationBytes {
		t.Fatalf("kept %d bytes, want at most %d", s.total, maxInvocationBytes)
	}
	want := 0
	for _, invocation := range s.list() {
		want += len(invocation.Input) + mb + len("done")
	}
	if s.total != want {
		t.Fatalf("counted %d bytes, the invocations kept hold %d", s.total, want)
	}
	if got := ids(s); got[len(got)-1] != "199" {
		t.Fatalf("the newest invocation is %s, want 199", got[len(got)-1])
	}
}

func TestStoreAlwaysKeepsTheNewestInvocation(t *testing.T) {
	s := newInvocationStore()
	s.add(invocation("old", "fn", 1))
	s.add(invocation("big", "fn", 1))
	s.grow("big", maxInvocationBytes+1)
	if got := ids(s); len(got) != 1 || got[0] != "big" {
		t.Fatalf("kept %v, want only the newest", got)
	}
}

func TestStoreKeepsTheNewestLogLines(t *testing.T) {
	s := newInvocationStore()
	s.add(invocation("a", "fn", 0))
	for i := range maxInvocationLogs + 10 {
		s.log("a", InvocationLog{Message: fmt.Sprintf("line %d", i)})
	}
	got, _ := s.get("a")
	if len(got.Logs) != maxInvocationLogs {
		t.Fatalf("kept %d lines, want %d", len(got.Logs), maxInvocationLogs)
	}
	if got.Logs[0].Message != "line 10" {
		t.Fatalf("the oldest line kept is %q, want %q", got.Logs[0].Message, "line 10")
	}
	want := 0
	for _, line := range got.Logs {
		want += len(line.Message)
	}
	if s.total != want {
		t.Fatalf("counted %d bytes, the lines kept hold %d", s.total, want)
	}
}

func TestStoreClearsBySource(t *testing.T) {
	s := newInvocationStore()
	s.add(invocation("a1", "a", 10))
	s.add(invocation("b1", "b", 10))
	s.add(invocation("a2", "a", 10))
	s.clear("a")
	if got := ids(s); len(got) != 1 || got[0] != "b1" {
		t.Fatalf("kept %v, want [b1]", got)
	}
	if s.total != 10 {
		t.Fatalf("counted %d bytes, want 10", s.total)
	}
	s.clear("all")
	if len(s.list()) != 0 || s.total != 0 {
		t.Fatalf("kept %d invocations and %d bytes after clearing all", len(s.list()), s.total)
	}
}
