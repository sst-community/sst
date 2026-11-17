// Package eject writes a Pulumi program's SST components as Pulumi's own
// resources, from the stack's state, and takes SST's own resources out of
// the state, so that the program needs nothing of SST's and its next
// `pulumi up` changes nothing in the cloud (docs/plans/thin-layer, step 5).
package eject

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
)

// export is what `pulumi stack export` prints, as far as the eject reads it
type export struct {
	Version    int `json:"version"`
	Deployment struct {
		Resources         []*stateResource  `json:"resources"`
		PendingOperations []json.RawMessage `json:"pending_operations"`
	} `json:"deployment"`
}

// stateResource is a resource in the state (apitype.ResourceV3). Its values
// keep their numbers as they're written.
type stateResource struct {
	URN                     resource.URN              `json:"urn"`
	Custom                  bool                      `json:"custom"`
	Delete                  bool                      `json:"delete"`
	ID                      string                    `json:"id"`
	Type                    string                    `json:"type"`
	Inputs                  map[string]any            `json:"inputs"`
	Outputs                 map[string]any            `json:"outputs"`
	Parent                  resource.URN              `json:"parent"`
	Protect                 bool                      `json:"protect"`
	Taint                   bool                      `json:"taint"`
	External                bool                      `json:"external"`
	Dependencies            []resource.URN            `json:"dependencies"`
	Provider                string                    `json:"provider"`
	PropertyDependencies    map[string][]resource.URN `json:"propertyDependencies"`
	PendingReplacement      bool                      `json:"pendingReplacement"`
	AdditionalSecretOutputs []string                  `json:"additionalSecretOutputs"`
	CustomTimeouts          *timeouts                 `json:"customTimeouts"`
	RetainOnDelete          bool                      `json:"retainOnDelete"`
	DeletedWith             resource.URN              `json:"deletedWith"`
	ReplaceWith             []resource.URN            `json:"replaceWith"`
	IgnoreChanges           []string                  `json:"ignoreChanges"`
	ReplaceOnChanges        []string                  `json:"replaceOnChanges"`
	ReplacementTrigger      any                       `json:"replacementTrigger"`
	ViewOf                  resource.URN              `json:"viewOf"`
	ResourceHooks           map[string][]string       `json:"resourceHooks"`
	StackTrace              []struct {
		SourcePosition string `json:"sourcePosition"`
	} `json:"stackTrace"`
}

// timeouts are a resource's custom timeouts, in seconds
type timeouts struct {
	Create float64 `json:"create"`
	Update float64 `json:"update"`
	Delete float64 `json:"delete"`
}

func (r *stateResource) name() string {
	return r.URN.Name()
}

// providerURN is the URN of the provider a custom resource was made with,
// from its reference, `<urn>::<id>`
func (r *stateResource) providerURN() resource.URN {
	ref := r.Provider
	if i := strings.LastIndex(ref, "::"); i >= 0 {
		ref = ref[:i]
	}
	return resource.URN(ref)
}

// madeAt is where the program made the resource, like index.ts:4: the first
// place in the program's own files the state's stack trace has
func (r *stateResource) madeAt() string {
	for _, frame := range r.StackTrace {
		position, ok := strings.CutPrefix(frame.SourcePosition, "project:///")
		if !ok || strings.HasPrefix(position, "file:") || strings.Contains(position, "node_modules/") {
			continue
		}
		file, at, _ := strings.Cut(position, "#")
		line, _, _ := strings.Cut(at, ",")
		if line == "" {
			return file
		}
		return file + ":" + line
	}
	return ""
}

// readExport reads a state with its numbers as they're written
func readExport(data []byte) (*export, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var parsed export
	if err := decoder.Decode(&parsed); err != nil {
		return nil, fmt.Errorf("reading the stack's state: %w", err)
	}
	if parsed.Version != 3 {
		return nil, fmt.Errorf("the stack's state is in version %d of Pulumi's format, and sst eject reads version 3", parsed.Version)
	}
	return &parsed, nil
}

// hasChildren is whether a component has a component or a part in it
func (g *generator) hasChildren(urn resource.URN) bool {
	for _, r := range g.resources {
		if r.Parent == urn {
			if role := g.role[r.URN]; role == roleComponent || role == rolePart {
				return true
			}
		}
	}
	return false
}

func isDefaultProvider(r *stateResource) bool {
	return strings.HasPrefix(r.name(), "default")
}

func containsURN(list []resource.URN, urn resource.URN) bool {
	for _, item := range list {
		if item == urn {
			return true
		}
	}
	return false
}
