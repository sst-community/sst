package eventflow

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/sst/sst/v3/internal/util"
)

// Statuses are the run statuses runs.list filters on
var Statuses = []string{"RUNNING", "PAUSING", "PAUSED", "SUCCEEDED", "FAILED", "TIMED_OUT", "STOPPED"}

// ListFlags are the flags that pick runs, as typed
type ListFlags struct {
	Function string
	Status   string
	Since    string
	Limit    string
}

// ListArgs are the args of runs.list and runs.retryAll
type ListArgs struct {
	Function string `json:"function,omitempty"`
	Status   string `json:"status,omitempty"`
	From     string `json:"from,omitempty"`
	Limit    int    `json:"limit,omitempty"`
	Mode     string `json:"mode,omitempty"`
}

// MaxRetryAll is the most runs runs.retryAll takes
const MaxRetryAll = 100

// Args are the args of runs.list
func (f ListFlags) Args(now time.Time) (ListArgs, error) {
	args := ListArgs{Function: f.Function}
	if f.Status != "" {
		status, err := ParseStatus(f.Status)
		if err != nil {
			return ListArgs{}, err
		}
		args.Status = status
	}
	if f.Since != "" {
		from, err := ParseSince(f.Since, now)
		if err != nil {
			return ListArgs{}, err
		}
		args.From = from.UTC().Format(time.RFC3339)
	}
	if f.Limit != "" {
		limit, err := strconv.Atoi(f.Limit)
		if err != nil || limit < 1 || limit > 1000 {
			return ListArgs{}, util.NewReadableError(nil, fmt.Sprintf("--limit should be a number from 1 to 1000, not %q", f.Limit))
		}
		args.Limit = limit
	}
	return args, nil
}

// RetryAllArgs are the args of runs.retryAll in the mode given, "retry" or
// "replay": the failed runs, unless the flags pick another status
func (f ListFlags) RetryAllArgs(mode string, now time.Time) (ListArgs, error) {
	args, err := f.Args(now)
	if err != nil {
		return ListArgs{}, err
	}
	if args.Status == "" {
		args.Status = "FAILED"
	}
	if args.Limit > MaxRetryAll {
		return ListArgs{}, util.NewReadableError(nil, fmt.Sprintf("--limit can be at most %d when retrying or replaying runs in bulk", MaxRetryAll))
	}
	args.Mode = mode
	return args, nil
}

// MaxCancelAll is the most runs `cancel --all` stops in one call
const MaxCancelAll = 500

// CancelAllArgs is runs.cancelAll's arguments: the runs in flight that the
// flags pick
func (f ListFlags) CancelAllArgs(now time.Time) (ListArgs, error) {
	args, err := f.Args(now)
	if err != nil {
		return ListArgs{}, err
	}
	if args.Limit > MaxCancelAll {
		return ListArgs{}, util.NewReadableError(nil, fmt.Sprintf("--limit can be at most %d when cancelling runs in bulk", MaxCancelAll))
	}
	return args, nil
}

// ParseStatus is the status typed, as runs.list takes it: "failed" and
// "timed-out" are FAILED and TIMED_OUT
func ParseStatus(input string) (string, error) {
	status := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(input), "-", "_"))
	for _, s := range Statuses {
		if s == status {
			return s, nil
		}
	}
	return "", util.NewReadableError(nil, fmt.Sprintf("--status should be one of %s, not %q", strings.Join(Statuses, ", "), input))
}

// ParseSince is the time --since says: a duration back from now, like 90s,
// 30m, 1h, 2d or 1w, or a time, like 2026-11-24 or 2026-11-24T10:00:00Z
func ParseSince(input string, now time.Time) (time.Time, error) {
	s := strings.TrimSpace(input)
	if s == "" {
		return time.Time{}, util.NewReadableError(nil, "--since needs a value, like 1h")
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	d, err := parseDuration(s)
	if err != nil || d <= 0 {
		return time.Time{}, util.NewReadableError(nil, fmt.Sprintf("--since should be a duration like 30m, 1h or 2d, or a time like 2026-11-24T10:00:00Z, not %q", input))
	}
	return now.Add(-d), nil
}

// parseDuration is time.ParseDuration with days and weeks
func parseDuration(s string) (time.Duration, error) {
	for suffix, unit := range map[string]time.Duration{"d": 24 * time.Hour, "w": 7 * 24 * time.Hour} {
		if n, ok := strings.CutSuffix(s, suffix); ok {
			v, err := strconv.ParseFloat(n, 64)
			if err != nil {
				return 0, err
			}
			return time.Duration(v * float64(unit)), nil
		}
	}
	return time.ParseDuration(s)
}

// Event is an event to send
type Event struct {
	Name   string          `json:"name"`
	Data   json.RawMessage `json:"data,omitempty"`
	ID     string          `json:"id,omitempty"`
	Tenant string          `json:"tenant,omitempty"`
}

// SendArgs are the args of send, for one event; data is JSON
func SendArgs(name, data, id, tenant string) (map[string]any, error) {
	if strings.TrimSpace(name) == "" {
		return nil, util.NewReadableError(nil, "The event needs a name")
	}
	event := Event{Name: name, ID: id, Tenant: tenant}
	if data != "" {
		if !json.Valid([]byte(data)) {
			return nil, util.NewReadableError(nil, fmt.Sprintf("--data should be JSON, like '{\"orderId\":\"123\"}', not %s", data))
		}
		event.Data = json.RawMessage(data)
	}
	return map[string]any{"events": []Event{event}}, nil
}

// RunArgs are the args of an op on one run
func RunArgs(runID string) map[string]any {
	return map[string]any{"runId": runID}
}
