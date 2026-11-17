package eject

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
)

// withoutResources is the state, as `pulumi stack export` printed it, with
// the resources taken out, and every reference to them: as a dependency,
// and as what a resource is deleted with, and the inputs in set set to their
// values, in a resource's outputs too where it has them. Everything else is
// kept as written, its secrets encrypted as they were, for `pulumi stack
// import`.
func withoutResources(data []byte, remove map[resource.URN]bool, set map[resource.URN]map[string]string) ([]byte, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		return nil, fmt.Errorf("reading the stack's state: %w", err)
	}
	var deployment map[string]json.RawMessage
	if err := json.Unmarshal(top["deployment"], &deployment); err != nil {
		return nil, fmt.Errorf("reading the stack's state: %w", err)
	}
	var resources []map[string]json.RawMessage
	if err := json.Unmarshal(deployment["resources"], &resources); err != nil {
		return nil, fmt.Errorf("reading the stack's state: %w", err)
	}

	kept := make([]map[string]json.RawMessage, 0, len(resources))
	found, setFound := 0, 0
	for _, r := range resources {
		var urn resource.URN
		if err := json.Unmarshal(r["urn"], &urn); err != nil {
			return nil, fmt.Errorf("reading the stack's state: %w", err)
		}
		if remove[urn] {
			found++
			continue
		}
		if values := set[urn]; values != nil {
			if err := setValues(r, values); err != nil {
				return nil, fmt.Errorf("reading the stack's state: %w", err)
			}
			setFound++
		}
		var parent resource.URN
		if raw, ok := r["parent"]; ok {
			if err := json.Unmarshal(raw, &parent); err != nil {
				return nil, err
			}
		}
		if remove[parent] {
			return nil, fmt.Errorf("%s is in %s, which would leave the state", urn.Name(), parent.Name())
		}
		if raw, ok := r["provider"]; ok {
			var ref string
			if err := json.Unmarshal(raw, &ref); err != nil {
				return nil, err
			}
			if remove[(&stateResource{Provider: ref}).providerURN()] {
				return nil, fmt.Errorf("%s was made with a provider that would leave the state", urn.Name())
			}
		}
		if raw, ok := r["dependencies"]; ok {
			var dependencies []resource.URN
			if err := json.Unmarshal(raw, &dependencies); err != nil {
				return nil, err
			}
			if left := withoutURNs(dependencies, remove); len(left) == 0 {
				delete(r, "dependencies")
			} else if len(left) != len(dependencies) {
				r["dependencies"], _ = json.Marshal(left)
			}
		}
		if raw, ok := r["propertyDependencies"]; ok {
			var dependencies map[string][]resource.URN
			if err := json.Unmarshal(raw, &dependencies); err != nil {
				return nil, err
			}
			changed := false
			for key, urns := range dependencies {
				if left := withoutURNs(urns, remove); len(left) != len(urns) {
					dependencies[key] = left
					changed = true
				}
			}
			if changed {
				r["propertyDependencies"], _ = json.Marshal(dependencies)
			}
		}
		if raw, ok := r["deletedWith"]; ok {
			var with resource.URN
			if err := json.Unmarshal(raw, &with); err != nil {
				return nil, err
			}
			if remove[with] {
				delete(r, "deletedWith")
			}
		}
		kept = append(kept, r)
	}
	if found != len(remove) || setFound != len(set) {
		return nil, fmt.Errorf("the stack's state changed while it was read")
	}

	var err error
	if deployment["resources"], err = marshal(kept); err != nil {
		return nil, err
	}
	if top["deployment"], err = marshal(deployment); err != nil {
		return nil, err
	}
	return marshal(top)
}

// setValues sets a resource's inputs, and its outputs of the same keys
func setValues(r map[string]json.RawMessage, values map[string]string) error {
	for _, field := range []string{"inputs", "outputs"} {
		raw, ok := r[field]
		if !ok {
			continue
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return err
		}
		for key, value := range values {
			if _, ok := fields[key]; !ok && field == "outputs" {
				continue
			}
			fields[key], _ = json.Marshal(value)
		}
		var err error
		if r[field], err = marshal(fields); err != nil {
			return err
		}
	}
	return nil
}

func withoutURNs(urns []resource.URN, remove map[resource.URN]bool) []resource.URN {
	left := []resource.URN{}
	for _, urn := range urns {
		if !remove[urn] {
			left = append(left, urn)
		}
	}
	return left
}

// marshal is JSON without the characters HTML would need escaped escaped,
// as pulumi writes it
func marshal(value any) ([]byte, error) {
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}
