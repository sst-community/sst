package move

import (
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/sig"
	"github.com/sst/sst/v3/pkg/state"
)

// Restored is the state a stage goes back to SST 4 with, and what was done to
// the copy the move saved to make it.
type Restored struct {
	State *apitype.CheckpointV3
	// Refreshed counts the resources the move kept that were given SST 5's
	// view of them
	Refreshed int
	// Stale are the resources the move kept that are as the copy has them:
	// SST 4's provider for them isn't SST 5's, their secrets couldn't be
	// carried over, or they depend on one the move replaced
	Stale []resource.URN
	// Replaced are the resources in the cloud the copy has that SST 5's state
	// doesn't, other than code: the move replaced them, like a REST API's
	// deployment, so the copy names ones that may be gone
	Replaced []resource.URN
	// Dropped are the code objects taken out, which the move deleted
	Dropped []resource.URN
	// Unknown are the resources in the cloud SST 5's state has that the copy
	// has under no type, like the code the move uploaded under new keys. They
	// stay in the cloud. What SST 5 keeps when it's deleted, like the code
	// every `sst dev` stub shares, isn't one.
	Unknown []resource.URN
}

// codeObjects are the types SST 4 uploads a function's code with
var codeObjects = map[string]bool{
	"aws:s3/bucketObjectv2:BucketObjectv2": true,
	"aws:s3/bucketObject:BucketObject":     true,
}

// Restore makes the state a stage that moved goes back to SST 4 with, from the
// copy of SST 4's state the move saved and SST 5's state now.
//
// The copy has SST 4's inputs, which SST 4's next deploy compares with its
// config, but its view of the cloud is from before the move. Where the move
// changed a resource in place, like a function's environment or code, or a
// CloudFront function's version, SST 4 would see no change to make and leave
// SST 5's in place, or be refused for the old version. So each resource the
// move kept, the same type and id in both, is given SST 5's view of it, its
// outputs, as a refresh would, when the same provider wrote both. Then SST
// 4's deploy puts back what the move changed.
//
// Outputs hold secret values encrypted for the state's secrets provider. Each
// run of SST 5 can give the state a new one, with the same passphrase and a
// new salt, so recrypt decrypts a value of SST 5's state and encrypts it for
// the copy's. Without it, only outputs that hold no secret are carried over
// between states with different secrets providers.
//
// A resource the move replaced, other than code, stays as the copy has it,
// and so does each one that depends on it: SST 5's view of a REST API's stage
// names SST 5's deployment, and SST 4's deploy would point the stage back at
// one that's gone. A refresh of SST 4's sorts those out.
//
// The code objects the move deleted are taken out, with what depends on them:
// SST 4 would never upload them again, as their keys haven't changed, and its
// refresh fails on a component linked to a function whose code is gone. gone
// says whether one is no longer in the cloud.
func Restore(saved, current *apitype.CheckpointV3, gone func(apitype.ResourceV3) (bool, error), recrypt func(ciphertext string) (string, error)) (*Restored, error) {
	if saved == nil || saved.Latest == nil {
		return nil, fmt.Errorf("the copy the move saved has no state")
	}
	result := &Restored{State: saved}
	kept := map[string][]int{}
	var now []apitype.ResourceV3
	if current != nil && current.Latest != nil {
		now = current.Latest.Resources
	}
	for i, r := range now {
		if r.Custom && r.ID != "" && !r.Delete {
			kept[identity(r)] = append(kept[identity(r)], i)
		}
	}
	sameSecrets := current != nil && current.Latest != nil &&
		reflect.DeepEqual(saved.Latest.SecretsProviders, current.Latest.SecretsProviders)
	var savedProviders, currentProviders map[string]string
	savedProviders = providerVersions(saved.Latest.Resources)
	if current != nil && current.Latest != nil {
		currentProviders = providerVersions(current.Latest.Resources)
	}

	// What SST 5's state doesn't have: code the move deleted is dropped, and
	// anything else in the cloud is one the move replaced
	ids := map[resource.ID]bool{}
	drop := map[resource.URN]bool{}
	replaced := map[resource.URN]bool{}
	for _, r := range saved.Latest.Resources {
		ids[r.ID] = true
		if !inCloud(r) || len(kept[identity(r)]) > 0 {
			continue
		}
		if codeObjects[string(r.Type)] {
			isGone, err := gone(r)
			if err != nil {
				return nil, err
			}
			if isGone {
				drop[r.URN] = true
				result.Dropped = append(result.Dropped, r.URN)
			}
			continue
		}
		if !r.External {
			replaced[r.URN] = true
			result.Replaced = append(result.Replaced, r.URN)
		}
	}

	for i := range saved.Latest.Resources {
		r := &saved.Latest.Resources[i]
		matches := kept[identity(*r)]
		if !inCloud(*r) || len(matches) == 0 {
			continue
		}
		// Two of SST 5's resources with the same id: not one to guess at
		if len(matches) > 1 || dependsOn(*r, replaced) {
			result.Stale = append(result.Stale, r.URN)
			continue
		}
		match := now[matches[0]]
		version, ok := savedProviders[providerURN(r.Provider)]
		if !ok || version == "" || version != currentProviders[providerURN(match.Provider)] {
			result.Stale = append(result.Stale, r.URN)
			continue
		}
		outputs := match.Outputs
		if !sameSecrets && hasSecret(outputs) {
			if recrypt == nil {
				result.Stale = append(result.Stale, r.URN)
				continue
			}
			carried, err := recryptValue(outputs, recrypt)
			if err != nil {
				return nil, fmt.Errorf("carrying over a secret of %v: %w", r.URN, err)
			}
			outputs = carried.(map[string]interface{})
		}
		r.Outputs = outputs
		result.Refreshed++
	}
	for _, r := range now {
		if inCloud(r) && !r.External && !r.RetainOnDelete && !ids[r.ID] {
			result.Unknown = append(result.Unknown, r.URN)
		}
	}
	if len(drop) > 0 {
		resources := saved.Latest.Resources[:0:0]
		for _, r := range saved.Latest.Resources {
			if drop[r.URN] {
				continue
			}
			if drop[r.DeletedWith] {
				r.DeletedWith = ""
			}
			resources = append(resources, r)
		}
		saved.Latest.Resources = resources
		state.Repair(saved)
	}
	return result, nil
}

// Changed lists what's in the cloud in one state and not the other, by type
// and id: what was created, and what was deleted or replaced, between them
func Changed(before, after *apitype.CheckpointV3) (created, gone []resource.URN) {
	index := func(c *apitype.CheckpointV3) map[string]resource.URN {
		out := map[string]resource.URN{}
		if c == nil || c.Latest == nil {
			return out
		}
		for _, r := range c.Latest.Resources {
			if inCloud(r) {
				out[identity(r)] = r.URN
			}
		}
		return out
	}
	a, b := index(before), index(after)
	for key, urn := range b {
		if _, ok := a[key]; !ok {
			created = append(created, urn)
		}
	}
	for key, urn := range a {
		if _, ok := b[key]; !ok {
			gone = append(gone, urn)
		}
	}
	sort.Slice(created, func(i, j int) bool { return created[i] < created[j] })
	sort.Slice(gone, func(i, j int) bool { return gone[i] < gone[j] })
	return created, gone
}

// inCloud says whether a resource of a state is one in the cloud, of a
// provider's package: not a component, a provider's entry, one of SST's own
// or a dynamic one, or one being deleted
func inCloud(r apitype.ResourceV3) bool {
	if !r.Custom || r.ID == "" || r.Delete {
		return false
	}
	pkg, _, _ := strings.Cut(string(r.Type), ":")
	return pkg != "pulumi" && pkg != "pulumi-nodejs" && pkg != "sst"
}

func dependsOn(r apitype.ResourceV3, urns map[resource.URN]bool) bool {
	for _, dep := range r.Dependencies {
		if urns[dep] {
			return true
		}
	}
	for _, deps := range r.PropertyDependencies {
		for _, dep := range deps {
			if urns[dep] {
				return true
			}
		}
	}
	return false
}

// hasSecret says whether a value of a state holds a secret
func hasSecret(v interface{}) bool {
	switch v := v.(type) {
	case map[string]interface{}:
		if v[sig.Key] == sig.Secret {
			return true
		}
		for _, item := range v {
			if hasSecret(item) {
				return true
			}
		}
	case []interface{}:
		for _, item := range v {
			if hasSecret(item) {
				return true
			}
		}
	}
	return false
}

// recryptValue copies a value of a state with each secret in it encrypted
// again by recrypt
func recryptValue(v interface{}, recrypt func(string) (string, error)) (interface{}, error) {
	switch v := v.(type) {
	case map[string]interface{}:
		if v[sig.Key] == sig.Secret {
			ciphertext, ok := v["ciphertext"].(string)
			if !ok {
				return nil, fmt.Errorf("a secret without its ciphertext")
			}
			again, err := recrypt(ciphertext)
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{sig.Key: sig.Secret, "ciphertext": again}, nil
		}
		out := make(map[string]interface{}, len(v))
		for key, item := range v {
			copied, err := recryptValue(item, recrypt)
			if err != nil {
				return nil, err
			}
			out[key] = copied
		}
		return out, nil
	case []interface{}:
		out := make([]interface{}, len(v))
		for i, item := range v {
			copied, err := recryptValue(item, recrypt)
			if err != nil {
				return nil, err
			}
			out[i] = copied
		}
		return out, nil
	}
	return v, nil
}

func identity(r apitype.ResourceV3) string {
	return string(r.Type) + "\x00" + string(r.ID)
}

// providerURN is the provider's URN in a resource's reference to it, which
// is the URN and the provider's id after "::"
func providerURN(reference string) string {
	if i := strings.LastIndex(reference, "::"); i >= 0 {
		return reference[:i]
	}
	return reference
}

// providerVersions gives each provider of a package in the state by its URN,
// as "<package>@<version>". SST's own provider and the one that runs dynamic
// resources are left out: their resources hold the code that serves them, so
// one's outputs are never carried over to the other's.
func providerVersions(resources []apitype.ResourceV3) map[string]string {
	versions := map[string]string{}
	for _, r := range resources {
		pkg, ok := strings.CutPrefix(string(r.Type), "pulumi:providers:")
		if !ok || pkg == "pulumi-nodejs" || pkg == "sst" {
			continue
		}
		version, _ := r.Inputs["version"].(string)
		if version == "" {
			continue
		}
		versions[string(r.URN)] = pkg + "@" + version
	}
	return versions
}
