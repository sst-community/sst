package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"
)

func packet(id string, index int, data string, final bool) string {
	b, _ := json.Marshal(Packet{
		Type:  MessageResponse,
		ID:    id,
		Index: index,
		Data:  base64.StdEncoding.EncodeToString([]byte(data)),
		Final: final,
	})
	return string(b)
}

// passedOn feeds the packets to sorted, then a marker, and returns the packets it
// passed on before the marker, as "id/index".
func passedOn(t *testing.T, packets ...string) []string {
	t.Helper()
	sub := make(chan string, len(packets)+1)
	for _, p := range packets {
		sub <- p
	}
	sub <- packet("end", 0, "", true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan []string, 1)
	go func() {
		result := []string{}
		for p := range sorted(ctx, sub, nil) {
			if p.ID == "end" {
				break
			}
			result = append(result, fmt.Sprintf("%s/%d", p.ID, p.Index))
		}
		done <- result
	}()
	select {
	case result := <-done:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("sorted didn't pass on the end marker")
		return nil
	}
}

// The CLI sends a reply more than once. A copy of a message that was passed on
// whole is dropped.
func TestSortedDropsACopyOfAFinishedMessage(t *testing.T) {
	got := passedOn(t,
		packet("r1", 0, "hello", true),
		packet("r1", 0, "hello", true),
	)
	if want := []string{"r1/0"}; !slices.Equal(got, want) {
		t.Fatalf("passed on %v, want %v", got, want)
	}
}

// A copy fills in the packet a message is missing, and passes on nothing twice.
func TestSortedFillsInFromACopy(t *testing.T) {
	got := passedOn(t,
		packet("r2", 0, "he", false),
		// "r2/1" is lost, then the whole reply comes again
		packet("r2", 0, "he", false),
		packet("r2", 1, "llo", true),
	)
	if want := []string{"r2/0", "r2/1"}; !slices.Equal(got, want) {
		t.Fatalf("passed on %v, want %v", got, want)
	}
}

// Packets that arrive out of order are passed on in order.
func TestSortedOrdersPackets(t *testing.T) {
	got := passedOn(t,
		packet("r3", 1, "llo", true),
		packet("r3", 0, "he", false),
	)
	if want := []string{"r3/0", "r3/1"}; !slices.Equal(got, want) {
		t.Fatalf("passed on %v, want %v", got, want)
	}
}

// A bridge already deployed reads message types by number, so the ones it knows
// keep theirs, and a new one goes at the end.
func TestMessageTypesKeepTheirNumbers(t *testing.T) {
	if MessageProbe != 9 || MessageLogs != 10 || MessageResend != 11 {
		t.Fatalf("MessageProbe is %d, MessageLogs %d and MessageResend %d, want 9, 10 and 11", MessageProbe, MessageLogs, MessageResend)
	}
}

// A reply says its logs follow on every packet, and a packet from a CLI from
// before it says they don't.
func TestSortedPassesOnLogsFollow(t *testing.T) {
	withFlag, _ := json.Marshal(Packet{Type: MessageResponse, ID: "r4", Final: true, LogsFollow: true})
	sub := make(chan string, 2)
	sub <- string(withFlag)
	sub <- packet("r5", 0, "", true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := map[string]bool{}
	for p := range sorted(ctx, sub, nil) {
		got[p.ID] = p.LogsFollow
		if len(got) == 2 {
			break
		}
	}
	if !got["r4"] || got["r5"] {
		t.Fatalf("logsFollow was %v, want r4 true and r5 false", got)
	}
}
