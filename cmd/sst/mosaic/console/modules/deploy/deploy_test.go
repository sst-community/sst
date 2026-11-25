package deploy

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
	"github.com/sst/sst/v3/cmd/sst/mosaic/deployer"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/common"
)

func deploys(t *testing.T, msgs []console.Message) []Deploy {
	out := []Deploy{}
	for _, m := range msgs {
		if m.Type == "deploy" {
			var d Deploy
			if err := console.Decode(m, &d); err != nil {
				t.Fatal(err)
			}
			out = append(out, d)
		}
	}
	return out
}

const urn = "urn:pulumi:dev::app::sst:aws:Function$aws:lambda/function:Function::ApiFunction"

func TestADeploy(t *testing.T) {
	h, err := console.NewHarness(Module{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	h.Publish(&project.StackCommandEvent{App: "app", Stage: "dev", Command: "deploy"}, now)
	h.Publish(&apitype.ResourcePreEvent{Metadata: apitype.StepEventMetadata{URN: urn, Type: "aws:lambda/function:Function", Op: apitype.OpUpdate}}, now)
	h.Publish(&apitype.ResourcePreEvent{Metadata: apitype.StepEventMetadata{URN: "urn:x::y::sst:sst:Version::v", Type: "sst:sst:Version", Op: apitype.OpUpdate}}, now)
	h.Publish(&apitype.ResourcePreEvent{Metadata: apitype.StepEventMetadata{URN: "same", Type: "aws:s3/bucket:Bucket", Op: apitype.OpSame}}, now)
	h.Publish(&apitype.ResOutputsEvent{Metadata: apitype.StepEventMetadata{URN: urn, Type: "aws:lambda/function:Function", Op: apitype.OpUpdate}}, now.Add(1500*time.Millisecond))
	h.Publish(&apitype.DiagnosticEvent{Severity: "info", Message: "\x1b[1mhello\x1b[0m from the config\n"}, now)
	h.Publish(&project.CompleteEvent{
		Finished: true,
		Outputs:  map[string]interface{}{"api": "https://x.lambda-url.aws"},
		Hints:    map[string]string{urn: "https://x.lambda-url.aws"},
		// none of these are shown, and they're never sent
		Links:     common.Links{"Secret": common.Link{Properties: map[string]interface{}{"value": "hunter2-link"}}},
		Tunnels:   map[string]project.Tunnel{"t": {PrivateKey: "hunter2-key"}},
		Resources: []apitype.ResourceV3{{URN: urn, Outputs: map[string]interface{}{"secret": "hunter2-state"}}},
	}, now.Add(2*time.Second))

	msgs := h.Watch("deploy")
	raw, _ := json.Marshal(msgs)
	if strings.Contains(string(raw), "hunter2") {
		t.Fatalf("a secret of the state went to the page: %s", raw)
	}
	got := deploys(t, msgs)
	if len(got) != 1 {
		t.Fatalf("deploys %+v", got)
	}
	d := got[0]
	if d.Status != "ok" || d.Command != "deploy" || len(d.Resources) != 1 || d.Resources[0].Status != "done" || d.Resources[0].Duration != 1500 {
		t.Fatalf("deploy %+v %+v", d, d.Resources)
	}
	if len(d.Messages) != 1 || d.Messages[0].Text != "hello from the config" {
		t.Fatalf("messages %+v", d.Messages)
	}
	if d.Outputs["api"] != "https://x.lambda-url.aws" || d.Hints[urn] == "" {
		t.Fatalf("outputs %+v hints %+v", d.Outputs, d.Hints)
	}
}

func TestFailures(t *testing.T) {
	h, _ := console.NewHarness(Module{})
	now := time.Now()
	h.Publish(&project.StackCommandEvent{Command: "deploy"}, now)
	h.Publish(&project.CompleteEvent{Errors: []project.Error{{URN: urn, Message: "AccessDenied", Help: []string{"check the role"}}}, Finished: true}, now)
	// the deployer says so once the deploy's over
	h.Publish(&deployer.DeployFailedEvent{Error: "the deploy failed"}, now)
	h.Publish(&project.StackCommandEvent{Command: "deploy"}, now)
	h.Publish(&project.BuildFailedEvent{Error: "sst.config.ts: Unexpected token"}, now)
	h.Publish(&project.StackCommandEvent{Command: "deploy"}, now)
	h.Publish(&project.ConcurrentUpdateEvent{}, now)
	got := deploys(t, h.Watch("deploy"))
	if len(got) != 3 {
		t.Fatalf("%d deploys", len(got))
	}
	if got[0].Status != "error" || len(got[0].Errors) != 2 || got[0].Errors[0].Help[0] != "check the role" {
		t.Fatalf("first %+v", got[0])
	}
	if got[1].Status != "error" || got[1].Errors[0].Message != "sst.config.ts: Unexpected token" {
		t.Fatalf("second %+v", got[1])
	}
	if got[2].Status != "locked" {
		t.Fatalf("third %+v", got[2])
	}
}

func TestKeepsTheLastDeploys(t *testing.T) {
	h, _ := console.NewHarness(Module{})
	for i := 0; i < maxDeploys+5; i++ {
		h.Publish(&project.StackCommandEvent{Command: "deploy"}, time.Now())
		h.Publish(&project.CompleteEvent{Finished: true}, time.Now())
	}
	got := deploys(t, h.Watch("deploy"))
	if len(got) != maxDeploys || got[len(got)-1].ID != "d25" {
		t.Fatalf("%d deploys, last %s", len(got), got[len(got)-1].ID)
	}
}
