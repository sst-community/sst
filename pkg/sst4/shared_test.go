package sst4

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"testing"

	"github.com/sst/sst/v3/pkg/server/resource"
)

// The resources SST 4's components share with SST 5's are SST 5's own types
// (rpc.go). SST 4's components call them through the provider code Pulumi
// stored with each, which sends what SST 4 deployed: the inputs on a create,
// and the outputs as `olds` on an update and as `outs` on a delete. So a
// change to one of SST 5's structs mustn't lose or rename what that code
// sends. Each is checked against what SST 4 left in the lab.
var sharedShapes = map[string]struct {
	inputs, outputs func() any
}{
	"Aws.BucketFiles": {
		func() any { return &resource.BucketFilesInputs{} },
		func() any { return &resource.BucketFilesOutputs{} },
	},
	"Aws.DistributionDeploymentWaiter": {
		func() any { return &resource.DistributionDeploymentWaiterInputs{} },
		func() any { return &resource.DistributionDeploymentWaiterOutputs{} },
	},
	"Aws.DistributionInvalidation": {
		func() any { return &resource.DistributionInvalidationInputs{} },
		func() any { return &struct{}{} },
	},
	"Aws.KvKeys": {
		func() any { return &resource.KvKeysInputs{} },
		func() any { return &resource.KvKeysOutputs{} },
	},
	"Aws.KvRoutesUpdate": {
		func() any { return &resource.KvRoutesUpdateInputs{} },
		func() any { return &resource.KvRoutesUpdateOutputs{} },
	},
}

// The resource a dynamic resource's stored code calls, like Aws.KvKeys
var storedCall = regexp.MustCompile(`"((?:Aws|Cloudflare|Vercel)\.[A-Za-z]+|Run)"`)

func TestSharedResourcesTakeWhatSST4Sends(t *testing.T) {
	checked := map[string]int{}
	for _, name := range recordedStates {
		for _, r := range recordedResources(t, name) {
			if r.Type != "pulumi-nodejs:dynamic:Resource" {
				continue
			}
			code, _ := r.Inputs["__provider"].(string)
			call := storedCall.FindStringSubmatch(code)
			if call == nil {
				continue
			}
			shape, ok := sharedShapes[call[1]]
			if !ok {
				continue
			}
			inputs := withoutProvider(r.Inputs)
			outputs := withoutProvider(r.Outputs)
			for _, lost := range lostThrough(inputs, shape.inputs()) {
				t.Errorf("%s %s: its inputs lose %s", name, r.URN.Name(), lost)
			}
			for _, lost := range lostThrough(outputs, shape.outputs()) {
				t.Errorf("%s %s: its outputs lose %s", name, r.URN.Name(), lost)
			}
			checked[call[1]]++
		}
	}
	for call := range sharedShapes {
		if checked[call] == 0 {
			t.Errorf("no %s in the recorded states", call)
		}
	}
	t.Logf("checked %v", checked)
}

// The MicroVM image's prune isn't in the recordings: its fields are pinned to
// what SST 4's component sends (aws/providers/microvm-image-prune.ts on main)
func TestSharedMicrovmImagePruneFields(t *testing.T) {
	if fields := jsonFields(resource.MicrovmImagePruneInputs{}); !reflect.DeepEqual(fields, []string{"imageArn", "imageVersion", "keep", "region"}) {
		t.Errorf("the inputs are %v", fields)
	}
	if fields := jsonFields(resource.MicrovmImagePruneOutputs{}); len(fields) != 0 {
		t.Errorf("the outputs are %v", fields)
	}
}

func withoutProvider(values map[string]interface{}) map[string]interface{} {
	result := map[string]interface{}{}
	for key, value := range values {
		if key != "__provider" {
			result[key] = value
		}
	}
	return result
}

// lostThrough is what of sent is lost when it's read into a value of the
// struct and written again: each field, and each field in an object or a
// list, that's gone or has another value. Fields the struct adds are fine.
func lostThrough(sent map[string]interface{}, into any) []string {
	data, _ := json.Marshal(sent)
	if err := json.Unmarshal(data, into); err != nil {
		return []string{fmt.Sprintf("everything (%v)", err)}
	}
	again, _ := json.Marshal(into)
	var read interface{}
	json.Unmarshal(again, &read)
	return lost("", sent, read)
}

func lost(at string, sent, read interface{}) []string {
	switch sent := sent.(type) {
	case map[string]interface{}:
		readMap, ok := read.(map[string]interface{})
		if !ok {
			return []string{at + " (not an object)"}
		}
		keys := []string{}
		for key := range sent {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		found := []string{}
		for _, key := range keys {
			value, ok := readMap[key]
			if !ok {
				found = append(found, at+"."+key)
				continue
			}
			found = append(found, lost(at+"."+key, sent[key], value)...)
		}
		return found
	case []interface{}:
		readList, ok := read.([]interface{})
		if !ok || len(readList) != len(sent) {
			return []string{at + " (not the same list)"}
		}
		found := []string{}
		for i := range sent {
			found = append(found, lost(fmt.Sprintf("%s[%d]", at, i), sent[i], readList[i])...)
		}
		return found
	default:
		if !reflect.DeepEqual(sent, read) {
			return []string{fmt.Sprintf("%s (%v, read as %v)", at, sent, read)}
		}
		return nil
	}
}

// jsonFields are the names a struct's fields are written as, sorted
func jsonFields(value any) []string {
	data, _ := json.Marshal(value)
	var fields map[string]interface{}
	json.Unmarshal(data, &fields)
	names := []string{}
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
