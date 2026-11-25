// Package deploy is the console's deploy module: each deploy sst dev runs,
// its resources as they change, its errors and warnings, and what it outputs.
//
// It keeps nothing of the state a deploy reports (its resources' inputs and
// outputs, its links, a tunnel's key), only what the terminal prints.
//
// Messages, of module "deploy":
//
//   - "deploy": a deploy started, or, in a snapshot, one kept. See Deploy.
//   - "resource": a resource changed: {deploy, resource}. See Resource.
//   - "message": the program printed, or a resource said something:
//     {deploy, message}. See Note.
//   - "end": a deploy finished: {deploy, end, status, errors, outputs, hints}.
//     status is "ok", "error", "skipped", "cancelled", "locked" or
//     "interrupted".
//   - "warning": something to do something about, not of a deploy: a Note.
package deploy

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
	"github.com/sst/sst/v3/cmd/sst/mosaic/deployer"
	"github.com/sst/sst/v3/cmd/sst/mosaic/socket"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/types/typescript"
)

//go:embed web
var web embed.FS

const (
	maxDeploys   = 20
	maxResources = 2000
	maxMessages  = 500
	maxWarnings  = 100
	maxText      = 16 << 10
)

// the resources the terminal doesn't show either: they're SST's own, and
// change on every deploy
var ignored = map[string]bool{
	"sst:sst:Version":     true,
	"sst:sst:LinkRef":     true,
	"sst:sst:Moved":       true,
	"pulumi:pulumi:Stack": true,
}

type Module struct{}

func (Module) Name() string  { return "deploy" }
func (Module) Title() string { return "Deploy" }
func (Module) Web() fs.FS    { return must(fs.Sub(web, "web")) }

type Deploy struct {
	ID        string            `json:"id"`
	Command   string            `json:"command"`
	Start     int64             `json:"start"`
	End       int64             `json:"end,omitempty"`
	Status    string            `json:"status"`
	Resources []*Resource       `json:"resources"`
	Messages  []Note            `json:"messages"`
	Errors    []Failure         `json:"errors"`
	Outputs   map[string]string `json:"outputs,omitempty"`
	Hints     map[string]string `json:"hints,omitempty"`
	// Dropped is how many resources and messages weren't kept
	Dropped int `json:"dropped,omitempty"`

	byURN map[string]*Resource
}

type Resource struct {
	URN  string `json:"urn"`
	Type string `json:"type"`
	// Op is Pulumi's: create, update, delete, replace, ...
	Op       string `json:"op"`
	Status   string `json:"status"`
	Start    int64  `json:"start"`
	Duration int64  `json:"duration,omitempty"`
}

type Note struct {
	Level string `json:"level"`
	Text  string `json:"text"`
	URN   string `json:"urn,omitempty"`
	Time  int64  `json:"time"`
}

type Failure struct {
	URN     string   `json:"urn,omitempty"`
	Message string   `json:"message"`
	Help    []string `json:"help,omitempty"`
}

type end struct {
	Deploy  string            `json:"deploy"`
	End     int64             `json:"end"`
	Status  string            `json:"status"`
	Errors  []Failure         `json:"errors"`
	Outputs map[string]string `json:"outputs,omitempty"`
	Hints   map[string]string `json:"hints,omitempty"`
}

type store struct {
	c        *console.Console
	deploys  []*Deploy
	warnings []Note
	seq      int
}

func (Module) Start(ctx context.Context, c *console.Console) error {
	s := &store{c: c}
	c.On(&project.StackCommandEvent{}, func(evt any) {
		s.begin(evt.(*project.StackCommandEvent).Command)
	})
	c.On(&apitype.ResourcePreEvent{}, func(evt any) {
		m := evt.(*apitype.ResourcePreEvent).Metadata
		if ignored[m.Type] || m.Op == apitype.OpSame {
			return
		}
		s.resource(m.URN, m.Type, string(m.Op), "running")
	})
	c.On(&apitype.ResOutputsEvent{}, func(evt any) {
		m := evt.(*apitype.ResOutputsEvent).Metadata
		if ignored[m.Type] || m.Op == apitype.OpSame {
			return
		}
		s.resource(m.URN, m.Type, string(m.Op), "done")
	})
	c.On(&apitype.ResOpFailedEvent{}, func(evt any) {
		m := evt.(*apitype.ResOpFailedEvent).Metadata
		if ignored[m.Type] {
			return
		}
		s.resource(m.URN, m.Type, string(m.Op), "failed")
	})
	c.On(&apitype.DiagnosticEvent{}, func(evt any) {
		e := evt.(*apitype.DiagnosticEvent)
		text := strings.TrimRight(ansi.Strip(e.Message), " \t\r\n")
		if text == "" {
			return
		}
		level := "info"
		switch e.Severity {
		case "error":
			level = "error"
		case "warning":
			level = "warning"
		case "info#err":
			level = "stderr"
		case "debug":
			return
		}
		s.message(Note{Level: level, Text: text, URN: e.URN})
	})
	c.On(&project.PolicyAdvisoryEvent{}, func(evt any) {
		e := evt.(*project.PolicyAdvisoryEvent)
		s.message(Note{Level: "warning", Text: e.Policy + ": " + e.Message, URN: e.URN})
	})
	c.On(&project.BuildFailedEvent{}, func(evt any) {
		s.fail("error", Failure{Message: evt.(*project.BuildFailedEvent).Error})
	})
	c.On(&deployer.DeployFailedEvent{}, func(evt any) {
		if e := evt.(*deployer.DeployFailedEvent); e.Error != "" {
			s.fail("error", Failure{Message: e.Error})
		}
	})
	c.On(&project.ConcurrentUpdateEvent{}, func(evt any) {
		s.fail("locked", Failure{Message: "A concurrent update was detected on the app. Run `sst unlock` to remove the lock and try again."})
	})
	c.On(&project.CancelledEvent{}, func(evt any) { s.finish("cancelled", nil, nil, nil) })
	c.On(&project.SkipEvent{}, func(evt any) { s.finish("skipped", nil, nil, nil) })
	c.On(&project.CompleteEvent{}, func(evt any) { s.complete(evt.(*project.CompleteEvent)) })
	c.On(&typescript.WarningEvent{}, func(evt any) { s.warn(evt.(*typescript.WarningEvent).Message) })
	c.On(&aws.ConcurrencyWarningEvent{}, func(evt any) { s.warn(evt.(*aws.ConcurrencyWarningEvent).Message) })
	c.On(&socket.WarningEvent{}, func(evt any) { s.warn(evt.(*socket.WarningEvent).Message) })
	c.Snapshot("deploy", s.snapshot)
	return nil
}

func (s *store) now() int64 { return s.c.Now().UnixMilli() }

func (s *store) current() *Deploy {
	if len(s.deploys) == 0 {
		return nil
	}
	return s.deploys[len(s.deploys)-1]
}

func (s *store) begin(command string) *Deploy {
	if d := s.current(); d != nil && d.End == 0 {
		// it never said it finished
		s.finish("interrupted", nil, nil, nil)
	}
	s.seq++
	d := &Deploy{
		ID:        fmt.Sprintf("d%d", s.seq),
		Command:   command,
		Start:     s.now(),
		Status:    "running",
		Resources: []*Resource{},
		Messages:  []Note{},
		Errors:    []Failure{},
		byURN:     map[string]*Resource{},
	}
	s.deploys = append(s.deploys, d)
	if len(s.deploys) > maxDeploys {
		s.deploys = s.deploys[len(s.deploys)-maxDeploys:]
	}
	s.c.Emit("deploy", "deploy", d)
	return d
}

// running is the deploy that's running, started if none is, as when the
// console starts in the middle of one.
func (s *store) running() *Deploy {
	if d := s.current(); d != nil && d.End == 0 {
		return d
	}
	return s.begin("deploy")
}

func (s *store) resource(urn, typ, op, status string) {
	d := s.running()
	r, ok := d.byURN[urn]
	if !ok {
		if len(d.Resources) >= maxResources {
			d.Dropped++
			return
		}
		r = &Resource{URN: urn, Type: typ, Start: s.now()}
		d.byURN[urn] = r
		d.Resources = append(d.Resources, r)
	}
	r.Op = op
	r.Status = status
	if status != "running" {
		r.Duration = s.now() - r.Start
	}
	s.c.Emit("deploy", "resource", map[string]any{"deploy": d.ID, "resource": r})
}

func (s *store) message(n Note) {
	d := s.running()
	if len(d.Messages) >= maxMessages {
		d.Dropped++
		return
	}
	n.Text = clip(n.Text)
	n.Time = s.now()
	d.Messages = append(d.Messages, n)
	s.c.Emit("deploy", "message", map[string]any{"deploy": d.ID, "message": n})
}

// fail finishes the deploy with an error, as when its program didn't build.
// The deployer says a deploy failed once it's finished, so the error goes to
// the last deploy even if it ended.
func (s *store) fail(status string, f Failure) {
	f.Message = clip(f.Message)
	d := s.current()
	if d == nil || d.End == 0 {
		s.finish(status, []Failure{f}, nil, nil)
		return
	}
	d.Status = status
	d.Errors = append(d.Errors, f)
	s.c.Emit("deploy", "end", end{Deploy: d.ID, End: d.End, Status: d.Status, Errors: d.Errors, Outputs: d.Outputs, Hints: d.Hints})
}

func (s *store) finish(status string, errors []Failure, outputs, hints map[string]string) {
	d := s.running()
	d.End = s.now()
	d.Status = status
	d.Errors = append(d.Errors, errors...)
	d.Outputs = outputs
	d.Hints = hints
	s.c.Emit("deploy", "end", end{Deploy: d.ID, End: d.End, Status: d.Status, Errors: d.Errors, Outputs: outputs, Hints: hints})
}

func (s *store) complete(e *project.CompleteEvent) {
	if e.Old {
		return
	}
	d := s.current()
	if d != nil && d.End != 0 && (d.Status == "skipped" || d.Status == "cancelled" || d.Status == "locked" || d.Status == "error") {
		// it said why it finished already
		return
	}
	status := "ok"
	if !e.Finished {
		status = "interrupted"
	}
	failures := []Failure{}
	for _, err := range e.Errors {
		failures = append(failures, Failure{URN: err.URN, Message: clip(err.Message), Help: err.Help})
	}
	if len(failures) > 0 {
		status = "error"
	}
	outputs := map[string]string{}
	for k, v := range e.Outputs {
		outputs[k] = clip(fmt.Sprint(v))
	}
	hints := map[string]string{}
	for k, v := range e.Hints {
		hints[k] = v
	}
	s.finish(status, failures, outputs, hints)
}

func (s *store) warn(text string) {
	n := Note{Level: "warning", Text: clip(text), Time: s.now()}
	s.warnings = append(s.warnings, n)
	if len(s.warnings) > maxWarnings {
		s.warnings = s.warnings[len(s.warnings)-maxWarnings:]
	}
	s.c.Emit("deploy", "warning", n)
}

func (s *store) snapshot() []console.Message {
	out := []console.Message{}
	for _, w := range s.warnings {
		out = append(out, s.c.Message("deploy", "warning", w))
	}
	for _, d := range s.deploys {
		out = append(out, s.c.Message("deploy", "deploy", d))
	}
	return out
}

func clip(text string) string {
	return console.Clip(text, maxText)
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
