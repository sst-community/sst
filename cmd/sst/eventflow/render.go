package eventflow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/sst/sst/v3/cmd/sst/mosaic/ui"
)

// Times print in now's location, so what's rendered depends only on what's given

const timeLayout = "2006-01-02 15:04:05"

// Snapshot is what the live view shows
type Snapshot struct {
	Overview  Overview     `json:"overview"`
	Functions []Function   `json:"functions"`
	Limits    []Limit      `json:"leases"`
	Waits     []Wait       `json:"waits"`
	Runs      []RunSummary `json:"runs"`
}

// RenderSnapshot prints the live view of the EventFlow called name
func RenderSnapshot(w io.Writer, name string, s Snapshot, now time.Time) {
	o := s.Overview
	fmt.Fprintln(w, ui.TEXT_HIGHLIGHT_BOLD.Render("EventFlow")+"  "+ui.TEXT_NORMAL_BOLD.Render(name)+"  "+ui.TEXT_DIM.Render("updated "+now.Format("15:04:05")))
	fmt.Fprintln(w)
	dead := ui.TEXT_DIM.Render("0 dead letters")
	if o.DeadLetters.Count > 0 {
		dead = ui.TEXT_DANGER_BOLD.Render(plural(o.DeadLetters.Count, "dead letter"))
	}
	table(w, [][]string{
		{label("Queue"), fmt.Sprintf("%d waiting · %d in flight · %d delayed", o.Queue.Waiting, o.Queue.InFlight, o.Queue.Delayed)},
		{label("Dead"), dead},
		{label("Limits"), fmt.Sprintf("%d active · %d queued · %s", o.Leases.Active, o.Leases.Queued, plural(o.Leases.Limits, "limit"))},
		{label("Waits"), fmt.Sprintf("%s · %s", plural(o.Waits.Waits, "wait"), plural(o.Waits.CancelOns, "cancel-on"))},
	})

	heading(w, "Functions")
	if len(s.Functions) == 0 {
		dim(w, "No functions")
	}
	rows := [][]string{}
	for _, f := range s.Functions {
		rows = append(rows, []string{ui.TEXT_NORMAL_BOLD.Render(f.ID), triggers(f), ui.TEXT_DIM.Render(controls(f))})
	}
	table(w, rows)

	heading(w, "Concurrency")
	if len(s.Limits) == 0 {
		dim(w, "No concurrency limits in use")
	} else {
		rows = [][]string{header("LIMIT", "ACTIVE", "QUEUED", "TENANTS")}
		for _, l := range s.Limits {
			active := fmt.Sprint(l.Active)
			if l.Limit != nil {
				active = fmt.Sprintf("%d/%d", l.Active, *l.Limit)
			}
			queued := fmt.Sprint(l.Queued)
			if l.Queued > 0 {
				queued = ui.TEXT_WARNING.Render(queued)
			}
			rows = append(rows, []string{l.Label, active, queued, ui.TEXT_DIM.Render(topTenants(l.Tenants, 3))})
		}
		table(w, rows)
	}

	heading(w, "Waits")
	if len(s.Waits) == 0 {
		dim(w, "No runs waiting for an event")
	} else {
		rows = [][]string{header("EVENT", "WAITS", "CANCEL-ONS")}
		for _, c := range countWaits(s.Waits) {
			rows = append(rows, []string{c.event, fmt.Sprint(c.waits), fmt.Sprint(c.cancels)})
		}
		table(w, rows)
	}

	heading(w, "Latest runs")
	RenderRuns(w, s.Runs, now)
}

type waitCount struct {
	event          string
	waits, cancels int
}

// countWaits counts the waits by event, most first
func countWaits(waits []Wait) []waitCount {
	byEvent := map[string]*waitCount{}
	for _, w := range waits {
		c, ok := byEvent[w.Event]
		if !ok {
			c = &waitCount{event: w.Event}
			byEvent[w.Event] = c
		}
		if w.Kind == "cancel" {
			c.cancels++
		} else {
			c.waits++
		}
	}
	out := []waitCount{}
	for _, c := range byEvent {
		out = append(out, *c)
	}
	slices.SortFunc(out, func(a, b waitCount) int {
		if n := (b.waits + b.cancels) - (a.waits + a.cancels); n != 0 {
			return n
		}
		return strings.Compare(a.event, b.event)
	})
	return out
}

// topTenants is the n tenants with the most leases, like "acme 3, globex 1"
func topTenants(tenants map[string]int, n int) string {
	names := []string{}
	for t, count := range tenants {
		if count > 0 {
			names = append(names, t)
		}
	}
	slices.SortFunc(names, func(a, b string) int {
		if d := tenants[b] - tenants[a]; d != 0 {
			return d
		}
		return strings.Compare(a, b)
	})
	parts := []string{}
	for i, t := range names {
		if i == n {
			parts = append(parts, fmt.Sprintf("+%d more", len(names)-n))
			break
		}
		if t == "" {
			t = "(none)"
		}
		parts = append(parts, fmt.Sprintf("%s %d", t, tenants[t]))
	}
	return strings.Join(parts, ", ")
}

// RenderFunctions prints the functions, a block each
func RenderFunctions(w io.Writer, functions []Function) {
	if len(functions) == 0 {
		dim(w, "No functions")
		return
	}
	for i, f := range functions {
		if i > 0 {
			fmt.Fprintln(w)
		}
		title := ui.TEXT_NORMAL_BOLD.Render(f.ID)
		if f.Name != "" && f.Name != f.ID {
			title += "  " + ui.TEXT_DIM.Render(f.Name)
		}
		fmt.Fprintln(w, title)
		rows := [][]string{{label("Triggers"), triggers(f)}}
		if c := controls(f); c != "" {
			rows = append(rows, []string{label("Limits"), c})
		}
		for _, c := range f.CancelOn {
			text := c.Event
			if c.Match != "" {
				text += " match " + c.Match
			}
			if c.If != "" {
				text += " if " + c.If
			}
			rows = append(rows, []string{label("Cancel on"), text})
		}
		table(w, rows)
	}
}

// triggers is what starts a function, like "order.created, cron(0 9 * * ? *) UTC"
func triggers(f Function) string {
	parts := []string{}
	for _, t := range f.Triggers {
		switch {
		case t.Event != "" && t.If != "":
			parts = append(parts, t.Event+" if "+t.If)
		case t.Event != "":
			parts = append(parts, t.Event)
		case t.Cron != "":
			parts = append(parts, strings.TrimSpace(t.Cron+" "+t.Timezone))
		case t.Invoke:
			parts = append(parts, "invoke")
		}
	}
	if len(parts) == 0 {
		return "(no triggers)"
	}
	return strings.Join(parts, ", ")
}

// controls is a function's retries and flow control, like
// "3 retries · concurrency 5 by event.data.tenant · throttle 10/s"
func controls(f Function) string {
	parts := []string{plural(f.Retries, "retry")}
	for _, c := range f.Concurrency {
		text := fmt.Sprintf("concurrency %d", c.Limit)
		if c.Key != "" {
			text += " by " + c.Key
		}
		if c.Scope != "" && c.Scope != "fn" {
			text += " (" + c.Scope + " scope)"
		}
		parts = append(parts, text)
	}
	if f.Throttle != nil {
		text := "throttle " + number(f.Throttle.PerSecond) + "/s"
		if f.Throttle.Burst > 0 {
			text += " burst " + number(f.Throttle.Burst)
		}
		parts = append(parts, text)
	}
	if f.RateLimit != nil {
		parts = append(parts, "rate limit "+number(f.RateLimit.PerSecond)+"/s")
	}
	if f.Idempotency {
		parts = append(parts, "idempotent")
	}
	return strings.Join(parts, " · ")
}

// RenderRuns prints a table of runs, the failed ones in red
func RenderRuns(w io.Writer, runs []RunSummary, now time.Time) {
	if len(runs) == 0 {
		dim(w, "No runs")
		return
	}
	rows := [][]string{header("RUN", "STATUS", "STARTED", "DURATION")}
	for _, r := range runs {
		id := r.ID
		if failed(r.Status) {
			id = ui.TEXT_DANGER.Render(id)
		}
		rows = append(rows, []string{id, status(r.Status), ago(r.StartedAt, now), took(&r.StartedAt, r.EndedAt, now)})
	}
	table(w, rows)
}

// RenderRun prints a run: what started it, its steps, what failed and where
// its logs are. The engine's own steps, like taking a lease, are left out
// unless allSteps is set.
func RenderRun(w io.Writer, r *Run, now time.Time, allSteps ...bool) {
	all := len(allSteps) > 0 && allSteps[0]
	fmt.Fprintln(w, ui.TEXT_NORMAL_BOLD.Render(r.ID)+"  "+status(r.Status))
	fmt.Fprintln(w)
	event := r.Event.Name
	if r.Event.ID != "" {
		event += "  " + ui.TEXT_DIM.Render(r.Event.ID)
	}
	if r.Event.Tenant != "" {
		event += "  " + ui.TEXT_DIM.Render("tenant "+r.Event.Tenant)
	}
	rows := [][]string{
		{label("Function"), r.Function},
		{label("Event"), event},
	}
	if data := compact(r.Event.Data, 200); data != "" {
		rows = append(rows, []string{label("Data"), data})
	}
	rows = append(rows, []string{label("Started"), r.StartedAt.In(now.Location()).Format(timeLayout) + "  " + ui.TEXT_DIM.Render(ago(r.StartedAt, now))})
	if r.EndedAt != nil {
		rows = append(rows, []string{label("Took"), took(&r.StartedAt, r.EndedAt, now)})
	}
	if r.Version != "" {
		rows = append(rows, []string{label("Version"), r.Version})
	}
	if r.ReplayOf != "" {
		rows = append(rows, []string{label("Rerun of"), r.ReplayOf})
	}
	if len(r.Reused) > 0 {
		rows = append(rows, []string{label("Reused"), strings.Join(r.Reused, ", ")})
	}
	if out := compact(r.Output, 200); out != "" {
		rows = append(rows, []string{label("Output"), out})
	}
	table(w, rows)

	heading(w, "Steps")
	if len(r.Steps) == 0 {
		dim(w, "No steps")
	} else {
		rows = [][]string{header("STEP", "TYPE", "STATUS", "ATTEMPTS", "DURATION")}
		for _, s := range r.Steps {
			if !all && internalStep(s.ID) {
				continue
			}
			id := s.ID
			if s.Status == "failed" || s.Status == "timed out" {
				id = ui.TEXT_DANGER.Render(id)
			}
			rows = append(rows, []string{id, s.Type, stepStatus(s.Status), fmt.Sprint(s.Attempts), took(s.StartedAt, s.EndedAt, now)})
		}
		table(w, rows)
	}

	if r.FailedStep != nil || r.Error != nil {
		heading(w, "Failure")
		rows = [][]string{}
		if r.FailedStep != nil {
			rows = append(rows, []string{label("Step"), ui.TEXT_DANGER_BOLD.Render(r.FailedStep.ID)})
			if r.FailedStep.Error != nil {
				rows = append(rows, []string{label("Error"), ui.TEXT_DANGER.Render(r.FailedStep.Error.Error())})
			}
		}
		// the run's error, when it isn't the step's again
		if r.Error != nil && (r.FailedStep == nil || r.FailedStep.Error == nil || r.Error.Message != r.FailedStep.Error.Message) {
			rows = append(rows, []string{label("Run error"), ui.TEXT_DANGER.Render(r.Error.Error())})
		}
		table(w, rows)
		if failed(r.Status) && Interrupted(r) {
			fmt.Fprintln(w, "  "+ui.TEXT_WARNING_BOLD.Render("A step stopped part way and may have done its side effect, like a payment.")+" Check it first. Then rerun with sst eventflow retry "+r.ID+" --force.")
		} else if failed(r.Status) {
			dim(w, "Deployed a fix? Run sst eventflow retry "+r.ID+" to run it again on the latest deploy, reusing the steps that succeeded.")
		}
	}

	if r.Links.Logs != "" || r.Links.LogGroup != "" {
		heading(w, "Logs")
		table(w, [][]string{
			{label("Group"), r.Links.LogGroup},
			{label("Console"), r.Links.Logs},
		})
	}
}

// RenderRerun prints what a retry or a replay of a run started
func RenderRerun(w io.Writer, mode string, r Rerun) {
	if r.Existing {
		past := "retried"
		if mode == "replay" {
			past = "replayed"
		}
		dim(w, fmt.Sprintf("%s was already %s as %s, so nothing new was started. Pass --again to %s it again.", r.ReplayOf, past, r.ID, mode))
		return
	}
	if mode == "replay" {
		success(w, fmt.Sprintf("Replaying %s as %s. Every step runs again.", r.ReplayOf, r.ID))
		return
	}
	msg := fmt.Sprintf("Retrying %s as %s, on the latest deploy.", r.ReplayOf, r.ID)
	if len(r.Reused) > 0 {
		msg += fmt.Sprintf(" Reusing the results of %s: %s.", plural(len(r.Reused), "step"), strings.Join(r.Reused, ", "))
	} else {
		msg += " No steps had succeeded, so every step runs again."
	}
	success(w, msg)
}

func success(w io.Writer, msg string) {
	fmt.Fprintln(w, ui.TEXT_SUCCESS_BOLD.Render(ui.IconCheck)+"  "+msg)
}

// RenderRerunAll prints what a bulk retry or replay did to each run, and
// returns how many it couldn't rerun
func RenderRerunAll(w io.Writer, mode string, results []RerunResult) int {
	verb := "Retried"
	if mode == "replay" {
		verb = "Replayed"
	}
	if len(results) == 0 {
		dim(w, "No runs matched, so nothing was "+strings.ToLower(verb))
		return 0
	}
	rows := [][]string{}
	failures := 0
	for _, r := range results {
		if r.Error != "" || r.Result == nil {
			failures++
			msg := r.Error
			if msg == "" {
				msg = "no new run"
			}
			rows = append(rows, []string{ui.TEXT_DANGER_BOLD.Render(ui.IconX), r.ID, ui.TEXT_DANGER.Render(msg)})
			continue
		}
		if r.Result.Existing {
			rows = append(rows, []string{ui.TEXT_DIM.Render("–"), r.ID, ui.TEXT_DIM.Render("already → " + r.Result.ID)})
			continue
		}
		rows = append(rows, []string{ui.TEXT_SUCCESS_BOLD.Render(ui.IconCheck), r.ID, ui.TEXT_DIM.Render("→ ") + r.Result.ID})
	}
	table(w, rows)
	fmt.Fprintln(w)
	summary := fmt.Sprintf("%s %d of %s", verb, len(results)-failures, plural(len(results), "run"))
	if failures > 0 {
		fmt.Fprintln(w, ui.TEXT_WARNING_BOLD.Render(summary))
	} else {
		fmt.Fprintln(w, ui.TEXT_SUCCESS_BOLD.Render(summary))
	}
	return failures
}

// RenderDeadLetters prints the dead letters looked at
func RenderDeadLetters(w io.Writer, letters []DeadLetter, now time.Time) {
	if len(letters) == 0 {
		dim(w, "No dead letters")
		return
	}
	rows := [][]string{header("MESSAGE", "KIND", "EVENT", "RECEIVED", "SENT")}
	for _, d := range letters {
		event := ""
		if d.Event != nil {
			event = d.Event.Name + " " + ui.TEXT_DIM.Render(d.Event.ID)
			if d.Event.Tenant != "" {
				event += ui.TEXT_DIM.Render(" tenant " + d.Event.Tenant)
			}
		} else if d.Body != "" {
			event = ui.TEXT_DIM.Render(truncate(strings.Join(strings.Fields(d.Body), " "), 60))
		}
		sent := ""
		if d.SentAt != nil {
			sent = ago(*d.SentAt, now)
		}
		rows = append(rows, []string{d.MessageID, d.Kind, event, plural(d.ReceiveCount, "time"), sent})
	}
	table(w, rows)
}

// table prints rows with their columns lined up, two spaces in
func table(w io.Writer, rows [][]string) {
	widths := []int{}
	for _, row := range rows {
		for i, cell := range row {
			if i == len(widths) {
				widths = append(widths, 0)
			}
			widths[i] = max(widths[i], lipgloss.Width(cell))
		}
	}
	for _, row := range rows {
		var line strings.Builder
		line.WriteString("  ")
		for i, cell := range row {
			line.WriteString(cell)
			if i < len(row)-1 {
				line.WriteString(strings.Repeat(" ", widths[i]-lipgloss.Width(cell)+2))
			}
		}
		fmt.Fprintln(w, strings.TrimRight(line.String(), " "))
	}
}

func header(cells ...string) []string {
	out := make([]string, len(cells))
	for i, c := range cells {
		out[i] = ui.TEXT_DIM.Render(c)
	}
	return out
}

func heading(w io.Writer, text string) {
	fmt.Fprintln(w)
	fmt.Fprintln(w, ui.TEXT_HIGHLIGHT_BOLD.Render(text))
}

func label(text string) string {
	return ui.TEXT_GRAY.Render(text)
}

func dim(w io.Writer, text string) {
	fmt.Fprintln(w, "  "+ui.TEXT_DIM.Render(text))
}

func failed(status string) bool {
	return status == "FAILED" || status == "TIMED_OUT"
}

func status(s string) string {
	switch s {
	case "FAILED", "TIMED_OUT":
		return ui.TEXT_DANGER_BOLD.Render(s)
	case "SUCCEEDED":
		return ui.TEXT_SUCCESS.Render(s)
	case "RUNNING", "PAUSING", "PAUSED":
		return ui.TEXT_HIGHLIGHT.Render(s)
	}
	return ui.TEXT_DIM.Render(s)
}

func stepStatus(s string) string {
	switch s {
	case "failed", "timed out":
		return ui.TEXT_DANGER_BOLD.Render(s)
	case "succeeded":
		return ui.TEXT_SUCCESS.Render(s)
	case "running", "waiting":
		return ui.TEXT_HIGHLIGHT.Render(s)
	}
	return ui.TEXT_DIM.Render(s)
}

// ago is how long before now t was, like "5m ago"
func ago(t time.Time, now time.Time) string {
	d := now.Sub(t)
	if d < 0 {
		d = 0
	}
	return short(d) + " ago"
}

// took is how long from start to end, or to now when it hasn't ended
func took(start, end *time.Time, now time.Time) string {
	if start == nil || start.IsZero() {
		return ""
	}
	if end == nil {
		return short(now.Sub(*start)) + "…"
	}
	return short(end.Sub(*start))
}

// short is a duration in its largest units, like 850ms, 4.2s, 3m12s, 5h4m or 2d3h
func short(d time.Duration) string {
	switch {
	case d < time.Second:
		return fmt.Sprintf("%dms", d.Milliseconds())
	case d < time.Minute:
		return fmt.Sprintf("%.1fs", d.Seconds())
	case d < time.Hour:
		return fmt.Sprintf("%dm%ds", int(d.Minutes()), int(d.Seconds())%60)
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh%dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dd%dh", int(d.Hours())/24, int(d.Hours())%24)
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	if strings.HasSuffix(word, "y") {
		return fmt.Sprintf("%d %sies", n, strings.TrimSuffix(word, "y"))
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func number(f float64) string {
	return strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%.2f", f), "0"), ".")
}

// compact is JSON on one line, cut at n runes
func compact(raw json.RawMessage, n int) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return truncate(string(raw), n)
	}
	return truncate(buf.String(), n)
}

func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n-1]) + "…"
}

// internalStep is a step the engine adds: what's in a step with a
// concurrency limit, a wait or an invoke, like "charge/lease:1.0", and the
// steps named "sst:..."
func internalStep(id string) bool {
	return strings.Contains(id, "/") || strings.HasPrefix(id, "sst:")
}

// CancelResult is what runs.cancelAll says about one run
type CancelResult struct {
	ID      string `json:"id"`
	Stopped bool   `json:"stopped,omitempty"`
	Error   string `json:"error,omitempty"`
}

// RenderCancelAll prints what cancel --all did to each run, and returns how
// many failed
func RenderCancelAll(w io.Writer, results []CancelResult) int {
	failed, stopped := 0, 0
	for _, r := range results {
		switch {
		case r.Error != "":
			failed++
			fmt.Fprintln(w, "  "+ui.TEXT_DANGER.Render("✕")+"  "+r.ID+"  "+ui.TEXT_DIM.Render(r.Error))
		case r.Stopped:
			stopped++
			fmt.Fprintln(w, "  "+ui.TEXT_SUCCESS.Render("✓")+"  "+r.ID)
		default:
			fmt.Fprintln(w, "  "+ui.TEXT_DIM.Render("·  "+r.ID+"  had already ended"))
		}
	}
	if len(results) == 0 {
		fmt.Fprintln(w, ui.TEXT_DIM.Render("No runs in flight"))
		return 0
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "Cancelled %d of %d runs\n", stopped, len(results))
	return failed
}

// Interrupted is whether a run failed because an atMostOnce step stopped part
// way. Its side effect may have happened, so it isn't rerun without --force
func Interrupted(r *Run) bool {
	for _, e := range []*AdminError{r.Error, stepError(r.FailedStep)} {
		if e != nil && (e.Name == "StepInterrupted" || strings.Contains(e.Message, "stopped part way") || strings.Contains(e.Message, "interruption")) {
			return true
		}
	}
	return false
}

func stepError(s *Step) *AdminError {
	if s == nil {
		return nil
	}
	return s.Error
}
