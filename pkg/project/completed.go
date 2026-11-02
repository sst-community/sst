package project

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
	"github.com/sst/sst/v3/pkg/id"
	"github.com/sst/sst/v3/pkg/project/common"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/sst/sst/v3/pkg/state"
)

func (p *Project) GetCompleted(ctx context.Context) (*CompleteEvent, error) {
	passphrase, err := provider.GetPassphrase(p.home, p.app.Name, p.app.Stage)
	if err != nil {
		return nil, err
	}
	workdir, err := p.NewWorkdir(id.Descending())
	if err != nil {
		return nil, err
	}
	defer workdir.Cleanup()
	_, err = workdir.Pull()
	if err != nil {
		return nil, err
	}
	return getCompletedEvent(ctx, passphrase, workdir)
}

func getCompletedEvent(ctx context.Context, passphrase string, workdir *PulumiWorkdir) (*CompleteEvent, error) {
	complete := &CompleteEvent{
		Links:       common.Links{},
		Versions:    map[string]int{},
		ImportDiffs: map[string][]ImportDiff{},
		Devs:        Devs{},
		Functions:   map[string]FunctionReport{},
		Tunnels:     map[string]Tunnel{},
		Hints:       map[string]string{},
		Outputs:     map[string]interface{}{},
		Tasks:       map[string]Task{},
		Errors:      []Error{},
		Finished:    false,
		Resources:   []apitype.ResourceV3{},
	}
	checkpoint, err := workdir.Export()
	if err != nil {
		return nil, err
	}
	decrypted, err := state.Decrypt(ctx, passphrase, checkpoint)
	if err != nil {
		return nil, err
	}
	deployment := decrypted.Latest
	if len(deployment.Resources) == 0 {
		return complete, nil
	}
	complete.Resources = deployment.Resources

	for _, res := range complete.Resources {
		if res.Type == MovedMarker {
			complete.Moved = true
			complete.MovedComponents = movedComponents(parsePlaintext(res.Outputs))
			continue
		}
		if res.Type == VersionsRecord {
			complete.RecordedVersions = movedComponents(parsePlaintext(res.Outputs))
			continue
		}
		outputs, ok := parsePlaintext(res.Outputs).(map[string]interface{})
		if !ok {
			continue
		}
		if typePackage(res.Type) == "sst" {
			if res.Type == "sst:sst:Version" {
				target, targetOk := outputs["target"].(string)
				version, versionOk := outputs["version"].(float64)
				if targetOk && versionOk {
					complete.Versions[target] = int(version)
				}
			}

			if res.Type != "sst:sst:Version" {
				name := res.URN.Name()
				_, ok := complete.Versions[name]
				if !ok {
					complete.Versions[name] = 1
				}
			}
		}
		report, err := readReport(outputs)
		if err != nil {
			return nil, err
		}
		if report != nil {
			complete.add(res.URN, report)
		}

		if res.Type == "sst:sst:LinkRef" {
			target, targetOk := outputs["target"].(string)
			properties, propertiesOk := outputs["properties"].(map[string]interface{})
			if !targetOk || !propertiesOk {
				continue
			}
			link := common.Link{
				Properties: properties,
				Include:    []common.LinkInclude{},
			}
			if includeSlice, ok := outputs["include"].([]interface{}); ok {
				for _, inc := range includeSlice {
					incMap, ok := inc.(map[string]interface{})
					if !ok {
						continue
					}
					incType, ok := incMap["type"].(string)
					if !ok {
						continue
					}
					link.Include = append(link.Include, common.LinkInclude{
						Type:  incType,
						Other: incMap,
					})
				}
			}
			complete.Links[target] = link
		}
	}

	if outputs, ok := parsePlaintext(deployment.Resources[0].Outputs).(map[string]interface{}); ok {
		for key, value := range outputs {
			if strings.HasPrefix(key, "_") {
				continue
			}
			complete.Outputs[key] = value
		}
	}

	return complete, nil
}

// add adds what a component reported to what the deploy left
func (complete *CompleteEvent) add(urn resource.URN, report *Report) {
	name := urn.Name()
	if report.Function != nil {
		complete.Functions[name] = *report.Function
	}
	if report.Dev != nil {
		dev := *report.Dev
		dev.Name = name
		complete.Devs[name] = dev
	}
	if report.Task != nil {
		task := *report.Task
		task.Name = name
		complete.Tasks[name] = task
	}
	// a tunnel is only of use with all three
	if tunnel := report.Tunnel; tunnel != nil && tunnel.IP != "" && tunnel.Username != "" && tunnel.PrivateKey != "" {
		if tunnel.Subnets == nil {
			tunnel.Subnets = []string{}
		}
		complete.Tunnels[name] = *tunnel
	}
	if report.Hint != "" {
		complete.Hints[string(urn)] = report.Hint
	}
}

func parsePlaintext(input interface{}) interface{} {
	switch cast := input.(type) {
	case apitype.SecretV1:
		var parsed any
		json.Unmarshal([]byte(cast.Plaintext), &parsed)
		return parsed
	case *apitype.SecretV1:
		var parsed any
		json.Unmarshal([]byte(cast.Plaintext), &parsed)
		return parsed
	case map[string]interface{}:
		for key, value := range cast {
			cast[key] = parsePlaintext(value)
		}
		return cast
	case []interface{}:
		for i, value := range cast {
			cast[i] = parsePlaintext(value)
		}
		return cast
	default:
		return cast
	}
}

// The package of a resource's type, its first part. A component's type can
// have two parts, like "acme:Uploads", which Pulumi's Module() fails on.
func typePackage(t tokens.Type) string {
	return strings.SplitN(string(t), ":", 2)[0]
}
