package project

import (
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/pkg/project/common"
)

func TestGeneratesTypes(t *testing.T) {
	t.Parallel()

	// what the stage has left. The Pulumi stack and the provider stay after any
	// remove of components, so they are resources but not links.
	resources := []apitype.ResourceV3{{}, {}}
	link := common.Links{"Files": {}}
	cases := []struct {
		name  string
		input StackInput
		links common.Links
		want  bool
	}{
		{"deploy", StackInput{Command: "deploy"}, link, true},
		{"deploy that left nothing", StackInput{Command: "deploy"}, nil, true},
		{"diff", StackInput{Command: "diff"}, link, true},
		{"refresh", StackInput{Command: "refresh"}, link, true},
		{"dev", StackInput{Command: "deploy", Dev: true}, link, true},
		{"remove of the whole stage", StackInput{Command: "remove"}, nil, false},
		{"remove of the whole stage, empty target", StackInput{Command: "remove", Target: []string{}}, nil, false},
		{"remove of one component, the rest stays", StackInput{Command: "remove", Target: []string{"Logs"}}, link, true},
		{"remove of the last component", StackInput{Command: "remove", Target: []string{"Files"}}, nil, false},
		{"remove of the whole stage that failed partway", StackInput{Command: "remove"}, link, true},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			complete := &CompleteEvent{Resources: resources, Links: c.links}
			if got := generatesTypes(&c.input, complete); got != c.want {
				t.Fatalf("generatesTypes(%+v, %d links) = %v, want %v", c.input, len(c.links), got, c.want)
			}
		})
	}
}
