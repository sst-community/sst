package eject

import (
	"fmt"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
)

// What an eject does: its options, the states it's given, and the plan it
// works out, which Run carries out. Build works it out.

// ConfigNamespace is where the module reads the secret inputs it was given,
// in the stack's config
const ConfigNamespace = "sst-ejected"

// ModuleFile and BuildFile are the files sst eject writes beside Pulumi.yaml,
// and WorkerFolder the folder it copies each Cloudflare Worker's last build
// to
const (
	ModuleFile   = "sst-ejected.ts"
	BuildFile    = "sst-ejected-build.ts"
	WorkerFolder = "sst-ejected-workers"
)

// Options says what the module is written from
type Options struct {
	// The Pulumi project's name
	Project string
	// The day it's written, for the module's first line
	Date string
	// The folder of the project's Pulumi.yaml. A path under it is written
	// from it, and a Worker's last build, in its .sst, is copied beside the
	// module. Without it, paths are written as the state has them.
	Root string
}

// StackState is a stack's state, as `pulumi stack export --show-secrets`
// prints it
type StackState struct {
	// The stack, as Pulumi names it
	Stack string
	Shown []byte
}

// Plan is what an eject writes and what it takes out of each stack's state,
// worked out from the states before anything is changed
type Plan struct {
	// sst-ejected.ts
	Module string
	// sst-ejected-build.ts, or "" when no function runs on Node.js
	Build string
	// The stacks the module is for, and what changes in each
	Stacks []*StackPlan
	// The stacks with none of SST's components, which it has nothing for
	Skipped []string
	// SST's components, now in the module, for what the eject says
	Components []Component
	// The program's own resources that use a component, for what the eject
	// says
	Uses []string
	// What the module's function is given of the program's own, like
	// `parents.shop: the program's "Shop" component`
	Takes []string
	// Each Worker's last build, copied beside the module, which a checkout
	// of the program doesn't have in .sst
	Files []CopiedFile
}

// CopiedFile is a file the eject copies into the project
type CopiedFile struct {
	// Where it goes, from the project's folder, with slashes
	Path string
	// Where it is
	From string
	// The SHA-256 of what the state says it is, in hex
	Sum string
}

// StackPlan is what an eject changes in one stack
type StackPlan struct {
	// The stack, as Pulumi names it
	Stack string
	// Its name, without its organization and project
	Name string
	// What's set in its config, under ConfigNamespace
	Config []Setting
	// What leaves its state, in the state's order
	Remove []resource.URN
	// What leaves its state, and why, for what the eject says
	Removed []Removed
	// What the module has that its state doesn't, which the first `pulumi
	// up` updates in place to what it already is in the cloud
	Updates []string
	// Inputs it sets in the state, by resource, to what the module has: a
	// Worker's code, copied, with the same content
	Inputs map[resource.URN]map[string]string
}

// Setting is a value set in a stack's config: a string as it is, and
// anything else as JSON
type Setting struct {
	Key    string
	Value  string
	Secret bool
}

type Component struct {
	Name   string
	Type   string
	MadeAt string
}

type Removed struct {
	Name string
	Type string
	Why  string
}

// Build works out the eject from the states of the project's stacks, read
// with their secrets shown, and writes the module. It refuses states it
// can't eject without a change in the cloud, saying why. A stack with none
// of SST's components is left out.
func Build(states []StackState, opts Options) (*Plan, error) {
	e := &ejector{
		opts:    opts,
		imports: map[string]string{},
		used: map[string]bool{
			"pulumi": true, "config": true, "program": true, "ejected": true,
			"stacks": true, "onStack": true, "byStack": true, "regionProvider": true,
			"path": true, "projectRoot": true,
		},
		names:        map[string]string{},
		in:           map[string][]int{},
		providerArgs: map[string]string{},
		parentArgs:   map[string]string{},
		takes:        map[string]string{},
	}
	plan := &Plan{}
	// Each stack's values are kept by its name, in Pulumi.<name>.yaml and the
	// backups, so two stacks of one name, in two organizations, can't be told
	// apart
	named := map[string]string{}
	for _, state := range states {
		name := stageOf(state.Stack)
		if other, ok := named[name]; ok {
			return nil, fmt.Errorf("Two stacks of the project are named %q: %s and %s. sst eject keeps each stack's values by its name, so it ejects only a project whose stacks have names of their own.", name, other, state.Stack)
		}
		named[name] = state.Stack
	}
	for _, state := range states {
		name := stageOf(state.Stack)
		parsed, err := readExport(state.Shown)
		if err != nil {
			return nil, err
		}
		if len(parsed.Deployment.PendingOperations) > 0 {
			return nil, fmt.Errorf("The %q stack has operations Pulumi didn't finish, like a deploy that was stopped. Run `pulumi refresh` on it first, and eject once it's clean.", name)
		}
		g := &generator{
			shared:      e,
			resources:   parsed.Deployment.Resources,
			byURN:       map[resource.URN]*stateResource{},
			role:        map[resource.URN]role{},
			vars:        map[resource.URN]string{},
			plan:        &StackPlan{Stack: state.Stack, Name: name},
			envUpdates:  map[string]map[string]any{},
			addedEnv:    map[resource.URN]map[string]any{},
			workerFiles: map[resource.URN]string{},
		}
		if err := g.classify(); err != nil {
			if len(states) > 1 {
				return nil, fmt.Errorf("The %q stack: %w", name, err)
			}
			return nil, err
		}
		if len(g.components) == 0 {
			plan.Skipped = append(plan.Skipped, name)
			continue
		}
		e.stacks = append(e.stacks, g)
		plan.Stacks = append(plan.Stacks, g.plan)
	}
	if len(e.stacks) == 0 {
		if len(states) == 1 {
			return nil, fmt.Errorf("The %q stack has none of SST's components, so there's nothing to eject.", stageOf(states[0].Stack))
		}
		return nil, fmt.Errorf("None of the project's stacks has SST's components, so there's nothing to eject.")
	}
	e.name()
	module, err := e.module()
	if err != nil {
		return nil, err
	}
	plan.Module = module
	for _, key := range e.providerOrder {
		name := "providers." + e.providerArgs[key]
		plan.Takes = append(plan.Takes, name+": "+e.takes[name])
	}
	for _, key := range e.parentOrder {
		name := "parents." + e.parentArgs[key]
		plan.Takes = append(plan.Takes, name+": "+e.takes[name])
	}
	if e.nodeBuild {
		plan.Build = buildModule
	}
	plan.Files = e.files
	seen := map[string]bool{}
	for _, g := range e.stacks {
		for _, c := range g.components {
			if !seen[c.Type+"::"+c.Name] {
				seen[c.Type+"::"+c.Name] = true
				plan.Components = append(plan.Components, c)
			}
		}
		for _, use := range g.uses() {
			if !seen[use] {
				seen[use] = true
				plan.Uses = append(plan.Uses, use)
			}
		}
	}
	return plan, nil
}
