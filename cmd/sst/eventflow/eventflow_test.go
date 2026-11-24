package eventflow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/sst/sst/v3/pkg/project/common"
)

var now = time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)

func flow(router string) common.Link {
	return common.Link{Properties: map[string]interface{}{
		"type":       LinkType,
		"routerName": router,
		"queueUrl":   "https://sqs.us-east-1.amazonaws.com/123/" + router,
	}}
}

func TestFind(t *testing.T) {
	bucket := common.Link{Properties: map[string]interface{}{"type": "sst.aws.Bucket", "name": "b"}}
	one := common.Links{"Jobs": flow("jobs-router"), "Uploads": bucket}
	two := common.Links{"Jobs": flow("jobs-router"), "Billing": flow("billing-router"), "Uploads": bucket}

	got, err := Find(one, "")
	if err != nil || got.Name != "Jobs" || got.RouterName != "jobs-router" || !strings.HasSuffix(got.QueueURL, "/jobs-router") {
		t.Fatalf("the only one: got %+v, %v", got, err)
	}
	if got, err := Find(two, "Billing"); err != nil || got.RouterName != "billing-router" {
		t.Fatalf("by name: got %+v, %v", got, err)
	}

	for _, tc := range []struct {
		name  string
		links common.Links
		pick  string
		want  string
	}{
		{"none", common.Links{"Uploads": bucket}, "", "This stage has no EventFlow"},
		{"several", two, "", "Pick one with --name: Billing, Jobs"},
		{"unknown", two, "Uploads", `no EventFlow called "Uploads". Its EventFlows are: Billing, Jobs`},
		{"no router", common.Links{"Jobs": {Properties: map[string]interface{}{"type": LinkType}}}, "", "has no router"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Find(tc.links, tc.pick)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want an error with %q", err, tc.want)
			}
		})
	}
}

func TestRequest(t *testing.T) {
	data, err := Request("runs.get", RunArgs("fn-1"))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"sst:eventflow:admin":{"args":{"runId":"fn-1"},"op":"runs.get"}}`; string(data) != want {
		t.Fatalf("got %s, want %s", data, want)
	}
	data, _ = Request("functions", nil)
	if want := `{"sst:eventflow:admin":{"args":{},"op":"functions"}}`; string(data) != want {
		t.Fatalf("got %s, want %s", data, want)
	}
}

func client(answer func(op string, args map[string]any) (string, string, error)) *Client {
	return &Client{Router: "jobs-router", Invoke: func(ctx context.Context, function string, payload []byte) ([]byte, string, error) {
		var req map[string]struct {
			Op   string         `json:"op"`
			Args map[string]any `json:"args"`
		}
		if err := json.Unmarshal(payload, &req); err != nil {
			return nil, "", err
		}
		if function != "jobs-router" {
			return nil, "", errors.New("wrong function " + function)
		}
		r := req[adminMarker]
		body, functionError, err := answer(r.Op, r.Args)
		return []byte(body), functionError, err
	}}
}

func TestCall(t *testing.T) {
	ctx := context.Background()
	ok := client(func(op string, args map[string]any) (string, string, error) {
		return `{"ok":true,"result":{"id":"` + args["runId"].(string) + `","stopped":true}}`, "", nil
	})
	var cancelled Cancelled
	raw, err := ok.Call(ctx, "runs.cancel", RunArgs("fn-1"), &cancelled)
	if err != nil || cancelled != (Cancelled{ID: "fn-1", Stopped: true}) || string(raw) != `{"id":"fn-1","stopped":true}` {
		t.Fatalf("got %+v %s %v", cancelled, raw, err)
	}

	for _, tc := range []struct {
		name          string
		body, fnError string
		want          string
	}{
		{"admin error", `{"ok":false,"error":{"name":"TypeError","message":"\"runs.get\" needs a runId."}}`, "", `TypeError: "runs.get" needs a runId.`},
		{"plain error", `{"ok":false,"error":{"name":"Error","message":"There's no run \"x\"."}}`, "", `There's no run "x".`},
		{"crash", `{"errorType":"Runtime.ImportModuleError","errorMessage":"Cannot find module"}`, "Unhandled", "router failed (Unhandled): Runtime.ImportModuleError: Cannot find module"},
		{"not json", `null-ish`, "", "isn't JSON"},
		{"not admin", `{"statusCode":200}`, "", "didn't answer the admin request"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := client(func(string, map[string]any) (string, string, error) { return tc.body, tc.fnError, nil })
			_, err := c.Call(ctx, "runs.get", RunArgs("x"), nil)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
		})
	}
}

func TestSnapshot(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]map[string]any{}
	c := client(func(op string, args map[string]any) (string, string, error) {
		mu.Lock()
		seen[op] = args
		mu.Unlock()
		results := map[string]string{
			"overview":  `{"functions":1,"queue":{"waiting":2,"inFlight":1,"delayed":0},"deadLetters":{"count":3},"leases":{"limits":1,"active":2,"queued":1},"waits":{"waits":1,"cancelOns":0}}`,
			"functions": `[{"id":"send-welcome","name":"Send welcome","triggers":[{"event":"user.created"}],"retries":3,"concurrency":[],"idempotency":false,"cancelOn":[]}]`,
			"leases":    `[{"label":"send-welcome","limit":5,"active":2,"queued":1,"tenants":{"acme":2},"leases":[]}]`,
			"waits":     `[{"kind":"wait","event":"user.verified","field":"data.userId","run":"r","createdAt":"2026-11-24T11:00:00Z","expiresAt":"2026-11-25T11:00:00Z"}]`,
			"runs.list": `[{"id":"send-welcome-1","arn":"arn","status":"FAILED","startedAt":"2026-11-24T11:59:00.000Z","endedAt":"2026-11-24T11:59:02.500Z"}]`,
		}
		return `{"ok":true,"result":` + results[op] + `}`, "", nil
	})
	s, raw, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.Overview.DeadLetters.Count != 3 || len(s.Functions) != 1 || *s.Limits[0].Limit != 5 || len(s.Waits) != 1 || s.Runs[0].Status != "FAILED" {
		t.Fatalf("got %+v", s)
	}
	if len(raw) != 5 || seen["runs.list"]["limit"] != float64(SnapshotRuns) {
		t.Fatalf("got %d parts, runs.list args %v", len(raw), seen["runs.list"])
	}

	var out bytes.Buffer
	RenderSnapshot(&out, "Jobs", s, now)
	text := ansi.Strip(out.String())
	for _, want := range []string{
		"EventFlow  Jobs  updated 12:00:00",
		"Queue   2 waiting · 1 in flight · 0 delayed",
		"Dead    3 dead letters",
		"send-welcome  user.created  3 retries",
		"send-welcome  2/5     1       acme 2",
		"user.verified  1      0",
		"send-welcome-1  FAILED  1m0s ago  2.5s",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the snapshot has no %q:\n%s", want, text)
		}
	}
}

func TestParseSince(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  time.Time
	}{
		{"1h", now.Add(-time.Hour)},
		{"30m", now.Add(-30 * time.Minute)},
		{"90s", now.Add(-90 * time.Second)},
		{"2d", now.Add(-48 * time.Hour)},
		{"1.5d", now.Add(-36 * time.Hour)},
		{"1w", now.Add(-7 * 24 * time.Hour)},
		{"2026-11-20T08:30:00Z", time.Date(2026, 11, 20, 8, 30, 0, 0, time.UTC)},
		{"2026-11-20", time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)},
	} {
		got, err := ParseSince(tc.input, now)
		if err != nil || !got.Equal(tc.want) {
			t.Errorf("ParseSince(%q) = %v, %v; want %v", tc.input, got, err, tc.want)
		}
	}
	for _, bad := range []string{"", "yesterday", "-1h", "0s", "1x", "d"} {
		if _, err := ParseSince(bad, now); err == nil {
			t.Errorf("ParseSince(%q) should fail", bad)
		}
	}
}

func TestListArgs(t *testing.T) {
	args, err := ListFlags{Function: "send-welcome", Status: "timed-out", Since: "1h", Limit: "20"}.Args(now)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(args)
	if want := `{"function":"send-welcome","status":"TIMED_OUT","from":"2026-11-24T11:00:00Z","limit":20}`; string(data) != want {
		t.Fatalf("got %s, want %s", data, want)
	}
	if args, _ := (ListFlags{}).Args(now); args != (ListArgs{}) {
		t.Fatalf("no flags should be no args, got %+v", args)
	}
	for _, bad := range []ListFlags{{Status: "done"}, {Limit: "0"}, {Limit: "ten"}, {Limit: "1001"}, {Since: "soon"}} {
		if _, err := bad.Args(now); err == nil {
			t.Errorf("%+v should fail", bad)
		}
	}
}

func TestRetryAllArgs(t *testing.T) {
	args, err := ListFlags{Function: "charge"}.RetryAllArgs("retry", now)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(args)
	if want := `{"function":"charge","status":"FAILED","mode":"retry"}`; string(data) != want {
		t.Fatalf("got %s, want %s", data, want)
	}
	args, _ = ListFlags{Status: "TIMED_OUT", Limit: "100"}.RetryAllArgs("replay", now)
	if args.Status != "TIMED_OUT" || args.Mode != "replay" || args.Limit != 100 {
		t.Fatalf("got %+v", args)
	}
	if _, err := (ListFlags{Limit: "101"}).RetryAllArgs("retry", now); err == nil {
		t.Fatal("a limit over 100 should fail")
	}
}

func TestSendArgs(t *testing.T) {
	args, err := SendArgs("order.created", `{"orderId": "123"}`, "order-123", "acme")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(args)
	if want := `{"events":[{"name":"order.created","data":{"orderId":"123"},"id":"order-123","tenant":"acme"}]}`; string(data) != want {
		t.Fatalf("got %s, want %s", data, want)
	}
	args, _ = SendArgs("ping", "", "", "")
	data, _ = json.Marshal(args)
	if want := `{"events":[{"name":"ping"}]}`; string(data) != want {
		t.Fatalf("got %s, want %s", data, want)
	}
	if _, err := SendArgs("ping", "{oops", "", ""); err == nil {
		t.Fatal("data that isn't JSON should fail")
	}
	if _, err := SendArgs(" ", "", "", ""); err == nil {
		t.Fatal("no name should fail")
	}
}

func TestRenderRun(t *testing.T) {
	var run *Run
	body := `{
		"id": "send-welcome-01J", "arn": "arn:aws:lambda:...", "status": "FAILED",
		"startedAt": "2026-11-24T11:55:00.000Z", "endedAt": "2026-11-24T11:55:04.200Z",
		"function": "send-welcome",
		"event": {"id": "evt-1", "name": "user.created", "data": {"userId": "u1"}, "ts": 1795000000000, "tenant": "acme"},
		"version": "7",
		"error": {"name": "Error", "message": "SMTP refused"},
		"replayOf": "send-welcome-00J",
		"reused": ["load-user"],
		"steps": [
			{"id": "load-user", "type": "step", "status": "succeeded", "attempts": 1, "startedAt": "2026-11-24T11:55:00.100Z", "endedAt": "2026-11-24T11:55:00.400Z"},
			{"id": "send-email", "type": "step", "status": "failed", "attempts": 3, "startedAt": "2026-11-24T11:55:00.500Z", "endedAt": "2026-11-24T11:55:04.100Z", "error": {"name": "SMTPError", "message": "SMTP refused"}}
		],
		"failedStep": {"id": "send-email", "type": "step", "status": "failed", "attempts": 3, "error": {"name": "SMTPError", "message": "SMTP refused"}},
		"links": {"logs": "https://console.aws.amazon.com/logs", "logGroup": "/aws/lambda/jobs-worker"}
	}`
	if err := json.Unmarshal([]byte(body), &run); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	RenderRun(&out, run, now)
	text := ansi.Strip(out.String())
	for _, want := range []string{
		"send-welcome-01J  FAILED",
		"Function  send-welcome",
		"Event     user.created  evt-1  tenant acme",
		`Data      {"userId":"u1"}`,
		"Started   2026-11-24 11:55:00  5m0s ago",
		"Took      4.2s",
		"Version   7",
		"Rerun of  send-welcome-00J",
		"Reused    load-user",
		"load-user   step  succeeded  1         300ms",
		"send-email  step  failed     3         3.6s",
		"Step   send-email",
		"Error  SMTPError: SMTP refused",
		"sst eventflow retry send-welcome-01J",
		"Group    /aws/lambda/jobs-worker",
		"Console  https://console.aws.amazon.com/logs",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the run has no %q:\n%s", want, text)
		}
	}
	// the run's error is the failed step's, so it isn't shown twice
	if strings.Contains(text, "Run error") {
		t.Errorf("the run's error is shown again:\n%s", text)
	}
	// unless it's another
	run.Error.Message = "Run timed out"
	out.Reset()
	RenderRun(&out, run, now)
	if text := ansi.Strip(out.String()); !strings.Contains(text, "Run error  Run timed out") {
		t.Errorf("the run's own error isn't shown:\n%s", text)
	}

	// a run that succeeded has no failure, and no hint to retry it
	run.Status, run.Error, run.FailedStep = "SUCCEEDED", nil, nil
	run.Steps = run.Steps[:1]
	out.Reset()
	RenderRun(&out, run, now)
	if text := ansi.Strip(out.String()); strings.Contains(text, "Failure") || strings.Contains(text, "retry") {
		t.Errorf("a run that succeeded shows a failure:\n%s", text)
	}
}

func TestRenderRerunAll(t *testing.T) {
	var results []RerunResult
	json.Unmarshal([]byte(`[{"id":"a","result":{"id":"a-r1"}},{"id":"b","error":"The run \"b\" is still running."}]`), &results)
	var out bytes.Buffer
	if failures := RenderRerunAll(&out, "retry", results); failures != 1 {
		t.Fatalf("got %d failures, want 1", failures)
	}
	text := ansi.Strip(out.String())
	for _, want := range []string{"✓  a  → a-r1", `✕  b  The run "b" is still running.`, "Retried 1 of 2 runs"} {
		if !strings.Contains(text, want) {
			t.Errorf("no %q:\n%s", want, text)
		}
	}
}

func TestControls(t *testing.T) {
	var f Function
	json.Unmarshal([]byte(`{"id":"charge","retries":1,"concurrency":[{"limit":5,"scope":"fn"},{"limit":1,"scope":"account","key":"event.data.customerId"}],"throttle":{"perSecond":0.5,"burst":2},"rateLimit":{"perSecond":10},"idempotency":true,
		"triggers":[{"event":"order.paid","if":"event.data.total > 0"},{"cron":"0 9 * * ? *","timezone":"UTC"},{"invoke":true}]}`), &f)
	if got, want := controls(f), "1 retry · concurrency 5 · concurrency 1 by event.data.customerId (account scope) · throttle 0.5/s burst 2 · rate limit 10/s · idempotent"; got != want {
		t.Errorf("controls: got %q, want %q", got, want)
	}
	if got, want := triggers(f), "order.paid if event.data.total > 0, 0 9 * * ? * UTC, invoke"; got != want {
		t.Errorf("triggers: got %q, want %q", got, want)
	}
}

func TestTopTenants(t *testing.T) {
	if got, want := topTenants(map[string]int{"a": 1, "b": 3, "c": 2, "d": 1, "e": 0}, 3), "b 3, c 2, a 1, +1 more"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestShort(t *testing.T) {
	for d, want := range map[time.Duration]string{
		850 * time.Millisecond:         "850ms",
		4200 * time.Millisecond:        "4.2s",
		3*time.Minute + 12*time.Second: "3m12s",
		5*time.Hour + 4*time.Minute:    "5h4m",
		51 * time.Hour:                 "2d3h",
	} {
		if got := short(d); got != want {
			t.Errorf("short(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestRenderRunHidesEngineSteps(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	run := &Run{RunSummary: RunSummary{ID: "r", Status: "FAILED", StartedAt: now}, Steps: []Step{
		{ID: "charge", Type: "step", Status: "succeeded", Attempts: 1},
		{ID: "charge/lease:1.0", Type: "step", Status: "succeeded", Attempts: 1},
		{ID: "sst:release", Type: "step", Status: "succeeded", Attempts: 1},
	}}
	var out bytes.Buffer
	RenderRun(&out, run, now)
	if strings.Contains(out.String(), "lease:1.0") || strings.Contains(out.String(), "sst:release") {
		t.Fatalf("engine steps shown:\n%s", out.String())
	}
	out.Reset()
	RenderRun(&out, run, now, true)
	if !strings.Contains(out.String(), "lease:1.0") {
		t.Fatalf("engine steps hidden with allSteps:\n%s", out.String())
	}
}

func TestCancelAll(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	args, err := ListFlags{Function: "import", Since: "1h"}.CancelAllArgs(now)
	if err != nil || args.Function != "import" || args.From != "2026-11-24T11:00:00Z" || args.Status != "" {
		t.Fatalf("args = %+v, %v", args, err)
	}
	if _, err := (ListFlags{Limit: "501"}).CancelAllArgs(now); err == nil {
		t.Fatal("a limit over 500 should be refused")
	}
	var out bytes.Buffer
	failed := RenderCancelAll(&out, []CancelResult{{ID: "a", Stopped: true}, {ID: "b"}, {ID: "c", Error: "boom"}})
	if failed != 1 || !strings.Contains(out.String(), "Cancelled 1 of 3 runs") {
		t.Fatalf("failed = %d, out:\n%s", failed, out.String())
	}
}

func TestInterruptedRun(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	step := &Step{ID: "charge", Type: "step", Status: "failed", Error: &AdminError{Name: "StepInterrupted", Message: "The step \"charge\" stopped part way"}}
	run := &Run{RunSummary: RunSummary{ID: "r", Status: "FAILED", StartedAt: now}, Steps: []Step{*step}, FailedStep: step}
	if !Interrupted(run) {
		t.Fatal("an interrupted step should be seen")
	}
	var out bytes.Buffer
	RenderRun(&out, run, now)
	if !strings.Contains(out.String(), "--force") || strings.Contains(out.String(), "Deployed a fix?") {
		t.Fatalf("the hint should say to check first:\n%s", out.String())
	}
}
