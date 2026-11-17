package eject

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/sig"
)

// The module's code from a stack's state: each part's declaration, its
// inputs as TypeScript, references to what it depends on, secrets read from
// the config, and its options. Nothing here knows SST's types.

// generator reads one stack's state: what the eject does with each
// resource, and each one the module makes, as that stack has it
type generator struct {
	shared    *ejector
	resources []*stateResource
	byURN     map[resource.URN]*stateResource
	role      map[resource.URN]role
	// The names the module refers to each component, part and provider by
	// (with a ! for one only some stacks have)
	vars map[resource.URN]string
	// The program's own providers parts were made with, and its own
	// resources SST's components are in, which the module's function is
	// given
	providers []resource.URN
	parents   []resource.URN
	plan      *StackPlan
	// SST's components made at the program's top level
	components []Component
	// What addEnvironment added to a function's environment after it was
	// made, by the function's name, then by the function
	envUpdates map[string]map[string]any
	addedEnv   map[resource.URN]map[string]any
	// Where a Worker's code is copied to, by its script, from the project's
	// folder
	workerFiles map[resource.URN]string
}

// projectPath is a path under the project's folder, written from it as
// Pulumi gives it, not from where the program runs: Pulumi runs a program
// from the folder of the project's main, like src/
func (g *generator) projectPath(rel string) expr {
	g.shared.usesPath = true
	return raw(fmt.Sprintf("path.join(projectRoot, %s)", quote(filepath.ToSlash(rel))))
}

// revealed is a value with its secret shown, as the state has it with its
// secrets shown, or the value as it is
func revealed(value any) any {
	wrapped, ok := value.(map[string]any)
	if !ok || wrapped[sig.Key] != sig.Secret {
		return value
	}
	text, ok := wrapped["plaintext"].(string)
	if !ok {
		return nil
	}
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var inner any
	if decoder.Decode(&inner) != nil {
		return nil
	}
	return inner
}

// partKey is a part's name without its component's, like function for
// ApiFunction in Api
func partKey(component, part string) string {
	key := strings.TrimPrefix(part, component)
	if key == "" {
		key = part
	}
	key = varName(key)
	return strings.TrimSuffix(key, "_")
}

// decl is how this stack has a component, a part or a provider SST makes
// for a region, for the module to make
func (g *generator) decl(r *stateResource) (*decl, error) {
	d := &decl{key: keyOf(r.URN), r: r, kind: g.role[r.URN]}
	if g.role[r.Parent] == roleComponent {
		d.parent = keyOf(r.Parent)
		d.needs = append(d.needs, d.parent)
	} else if containsURN(g.parents, r.Parent) {
		d.programParent = g.vars[r.Parent]
	}
	if d.kind != rolePart {
		return d, nil
	}
	class, err := g.class(r.Type)
	if err != nil {
		return nil, err
	}
	switch {
	case len(r.ReplaceWith) > 0:
		return nil, fmt.Errorf("%s is replaced with another resource (replaceWith), which sst eject doesn't write yet.", r.name())
	case r.ReplacementTrigger != nil:
		return nil, fmt.Errorf("%s has a replacement trigger, which sst eject doesn't write yet.", r.name())
	case len(r.ResourceHooks) > 0:
		return nil, fmt.Errorf("%s has resource hooks, which sst eject doesn't write yet.", r.name())
	case r.ViewOf != "":
		return nil, fmt.Errorf("%s is a view of another resource, which sst eject doesn't write yet.", r.name())
	}
	d.class = class
	d.comment = g.buildComment(r)
	var needs []resource.URN
	if r.External {
		d.external = true
		d.id = literal{r.ID}
		d.opts, needs = g.options(r, nil)
	} else {
		used := map[resource.URN]bool{}
		args, err := g.inputs(r, used)
		if err != nil {
			return nil, err
		}
		d.args = args
		d.opts, needs = g.options(r, used)
		for urn := range used {
			needs = append(needs, urn)
		}
	}
	for _, urn := range needs {
		d.needs = append(d.needs, keyOf(urn))
	}
	return d, nil
}

// class is the class Pulumi's package for a type has, like aws.lambda.Function
// for aws:lambda/function:Function
func (g *generator) class(token string) (string, error) {
	parts := strings.Split(token, ":")
	if len(parts) != 3 {
		return "", fmt.Errorf("sst eject can't write a resource of type %s.", token)
	}
	alias := g.shared.imports[parts[0]]
	module, _, _ := strings.Cut(parts[1], "/")
	if module == "index" || module == "" {
		return alias + "." + parts[2], nil
	}
	return alias + "." + module + "." + parts[2], nil
}

// valueAt is where a value is in a resource's inputs, for the config key
// of a secret and for what a reference matches
type valueAt struct {
	r    *stateResource
	path []string
	// The resources this input depends on that the module has, which a
	// value can be a reference to
	deps []resource.URN
	used map[resource.URN]bool
}

func (at valueAt) with(key string) valueAt {
	path := append(append([]string{}, at.path...), key)
	return valueAt{r: at.r, path: path, deps: at.deps, used: at.used}
}

func (at valueAt) where() string {
	var b strings.Builder
	b.WriteString(at.r.name())
	for _, key := range at.path {
		if !strings.HasPrefix(key, "[") {
			b.WriteString(".")
		}
		b.WriteString(key)
	}
	return b.String()
}

// inputs are a part's inputs, as the state has them, but for what the
// provider filled in itself: its defaults, the tags it adds and the region
// of its provider
func (g *generator) inputs(r *stateResource, used map[resource.URN]bool) (*object, error) {
	values := withoutDefaults(r.Inputs)
	delete(values, "tagsAll")
	if added := g.addedEnv[r.URN]; added != nil {
		values["environment"] = withEnvironment(values["environment"], added)
	}
	if region, ok := values["region"].(string); ok {
		if provider := g.byURN[r.providerURN()]; provider != nil && provider.Inputs["region"] == region {
			delete(values, "region")
		}
	}
	result := newObject()
	keys := sortedKeys(values)
	for _, key := range keys {
		if values[key] == nil {
			continue
		}
		// A Worker's code, copied beside the module
		if rel := g.workerFiles[r.URN]; rel != "" && key == "contentFile" {
			result.set(key, g.projectPath(rel))
			continue
		}
		at := valueAt{r: r, path: []string{key}, deps: g.declared(r.PropertyDependencies[key]), used: used}
		value, err := g.value(values[key], key, at)
		if err != nil {
			return nil, err
		}
		result.set(key, value)
	}
	return result, nil
}

// asSecret is a value as the state has a secret, with its value shown
func asSecret(value any) map[string]any {
	text, _ := marshal(value)
	return map[string]any{sig.Key: sig.Secret, "plaintext": string(text)}
}

// declared are those of the URNs the module has a name for
func (g *generator) declared(urns []resource.URN) []resource.URN {
	var result []resource.URN
	seen := map[resource.URN]bool{}
	var visit func(urn resource.URN)
	visit = func(urn resource.URN) {
		if seen[urn] {
			return
		}
		seen[urn] = true
		if name, ok := g.vars[urn]; ok {
			if !strings.HasPrefix(name, "program.") {
				result = append(result, urn)
			}
			return
		}
		// What leaves the state can carry a value of what it was made from:
		// a function's code object has the bucket of the program's Assets,
		// which the function then refers to
		if r := g.byURN[urn]; r != nil && g.role[urn] == roleRemove {
			for _, dep := range r.Dependencies {
				visit(dep)
			}
		}
	}
	for _, urn := range urns {
		visit(urn)
	}
	return result
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// withoutDefaults is an object without what the provider filled in with a
// default, which it lists under __defaults: given nothing, it fills them in
// the same way
func withoutDefaults(values map[string]any) map[string]any {
	result := make(map[string]any, len(values))
	for key, value := range values {
		result[key] = value
	}
	defaults, ok := result["__defaults"].([]any)
	if !ok {
		return result
	}
	delete(result, "__defaults")
	for _, key := range defaults {
		if name, ok := key.(string); ok {
			delete(result, name)
		}
	}
	return result
}

// value is an input's value as TypeScript: a reference where it's what a
// resource it depends on gives, a secret from the config, or as it is
func (g *generator) value(value any, key string, at valueAt) (expr, error) {
	switch value := value.(type) {
	case map[string]any:
		if kind, ok := value[sig.Key].(string); ok {
			if kind == sig.Secret {
				return g.secret(value, key, at)
			}
			if kind == sig.AssetSig || kind == sig.ArchiveSig {
				return nil, fmt.Errorf("%s takes a file at %s, which sst eject doesn't write yet.", at.r.name(), at.where())
			}
			return nil, fmt.Errorf("%s has a value at %s that sst eject doesn't write yet.", at.r.name(), at.where())
		}
		values := withoutDefaults(value)
		result := newObject()
		for _, k := range sortedKeys(values) {
			if values[k] == nil {
				continue
			}
			item, err := g.value(values[k], k, at.with(k))
			if err != nil {
				return nil, err
			}
			result.set(k, item)
		}
		return result, nil
	case []any:
		result := make(array, len(value))
		for i, v := range value {
			item, err := g.value(v, key, at.with(fmt.Sprintf("[%d]", i)))
			if err != nil {
				return nil, err
			}
			result[i] = item
		}
		return result, nil
	case string:
		if ref := g.match(value, key, at); ref != nil {
			return ref, nil
		}
		// A path in the project, like a site's files, from wherever it's
		// checked out
		if root := g.shared.opts.Root; root != "" && filepath.IsAbs(value) {
			if rel, err := filepath.Rel(root, value); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return g.projectPath(rel), nil
			}
		}
		if parsed, ok := parseJSONText(value); ok {
			if indent, ok := jsonIndent(value, parsed); ok {
				written := g.jsonValue(parsed, key, at)
				return jsonText{value: written, indent: indent, refs: hasRef(written)}, nil
			}
		}
		return literal{value}, nil
	}
	return literal{value}, nil
}

// jsonValue is a string's JSON as a value, with references where a string
// in it is what a resource the input depends on gives
func (g *generator) jsonValue(value any, key string, at valueAt) expr {
	switch value := value.(type) {
	case *orderedObject:
		result := newObject()
		for _, k := range value.keys {
			result.set(k, g.jsonValue(value.values[k], k, at))
		}
		return result
	case []any:
		result := make(array, len(value))
		for i, v := range value {
			result[i] = g.jsonValue(v, key, at)
		}
		return result
	case string:
		if ref := g.match(value, key, at); ref != nil {
			return ref
		}
	}
	return literal{value}
}

func hasRef(value expr) bool {
	switch value := value.(type) {
	case raw, interpolated:
		return true
	case *object:
		for _, key := range value.keys {
			if hasRef(value.values[key]) {
				return true
			}
		}
	case array:
		for _, item := range value {
			if hasRef(item) {
				return true
			}
		}
	}
	return false
}

// secret is a secret input: a reference when it's what a resource it
// depends on gives, and otherwise read from the stack's config, where the
// eject puts it
func (g *generator) secret(value map[string]any, key string, at valueAt) (expr, error) {
	if _, ok := value["plaintext"].(string); !ok {
		return nil, fmt.Errorf("the state was read without its secrets shown")
	}
	inner := revealed(value)
	if text, ok := inner.(string); ok {
		// Only the whole of it: a reference with text after it would write
		// that text, part of the secret, in the code
		if ref := g.exactMatch(text, key, at); ref != nil {
			return ref, nil
		}
	}
	if object, ok := inner.(map[string]any); ok {
		inner = withoutDefaults(object)
	}
	if hasSignature(inner) {
		return nil, fmt.Errorf("%s has a secret at %s that sst eject doesn't write yet.", at.r.name(), at.where())
	}
	return stackSecret{path: at.where(), value: inner}, nil
}

func hasSignature(value any) bool {
	switch value := value.(type) {
	case map[string]any:
		if _, ok := value[sig.Key]; ok {
			return true
		}
		for _, v := range value {
			if hasSignature(v) {
				return true
			}
		}
	case []any:
		for _, v := range value {
			if hasSignature(v) {
				return true
			}
		}
	}
	return false
}

// candidate is an output of a resource a value can be a reference to
type candidate struct {
	urn   resource.URN
	key   string
	value string
}

func (g *generator) candidates(deps []resource.URN) []candidate {
	var result []candidate
	for _, urn := range deps {
		r := g.byURN[urn]
		if g.role[urn] != rolePart {
			continue
		}
		for _, key := range sortedKeys(r.Outputs) {
			if strings.HasPrefix(key, "__") || !identifier.MatchString(key) {
				continue
			}
			if text, ok := revealed(r.Outputs[key]).(string); ok && text != "" {
				result = append(result, candidate{urn: urn, key: key, value: text})
			}
		}
		if r.ID != "" {
			result = append(result, candidate{urn: urn, key: "id", value: r.ID})
		}
	}
	return result
}

// match is a reference for a string that's what a resource the input
// depends on gives, or the start of it, like a bucket's ARN in
// `arn:aws:s3:::bucket/*`. Short strings, which could be the same by
// chance, aren't matched.
func (g *generator) match(text, key string, at valueAt) expr {
	if ref := g.exactMatch(text, key, at); ref != nil {
		return ref
	}
	if len(text) < 8 || len(at.deps) == 0 {
		return nil
	}
	all := g.candidates(at.deps)
	var prefix []candidate
	for _, c := range all {
		if len(c.value) >= 12 && len(text) > len(c.value) && strings.HasPrefix(text, c.value) && strings.ContainsRune("/:", rune(text[len(c.value)])) {
			prefix = append(prefix, c)
		}
	}
	// The longest one, then as for an exact match
	sort.SliceStable(prefix, func(i, j int) bool { return len(prefix[i].value) > len(prefix[j].value) })
	if len(prefix) > 0 {
		longest := len(prefix[0].value)
		var same []candidate
		for _, c := range prefix {
			if len(c.value) == longest {
				same = append(same, c)
			}
		}
		best, _ := bestOf(same, key)
		at.used[best.urn] = true
		return interpolated{ref: g.vars[best.urn] + "." + best.key, suffix: text[len(best.value):]}
	}
	return nil
}

// exactMatch is the output of what a value depends on that the value is,
// whole, as a reference, or nil
func (g *generator) exactMatch(text, key string, at valueAt) expr {
	if len(text) < 8 || len(at.deps) == 0 {
		return nil
	}
	var exact []candidate
	for _, c := range g.candidates(at.deps) {
		if c.value == text {
			exact = append(exact, c)
		}
	}
	if best, ok := bestOf(exact, key); ok {
		at.used[best.urn] = true
		return raw(g.vars[best.urn] + "." + best.key)
	}
	return nil
}

// bestOf is the output a value at key most likely is: the output of the
// same name, then the one its name ends in (an ARN for policyArn), then an
// ARN, a name and an id
func bestOf(candidates []candidate, key string) (candidate, bool) {
	if len(candidates) == 0 {
		return candidate{}, false
	}
	rank := func(c candidate) int {
		if c.key == key {
			return 0
		}
		lower := strings.ToLower(key)
		for _, ending := range []string{"arn", "name", "id"} {
			if strings.HasSuffix(lower, ending) && c.key == ending {
				return 1
			}
		}
		// What the input is named after: a function's s3Bucket is a bucket's
		// bucket
		if len(c.key) >= 4 && strings.HasSuffix(lower, strings.ToLower(c.key)) {
			return 1
		}
		switch c.key {
		case "arn":
			return 2
		case "name":
			return 3
		case "id":
			return 4
		}
		return 5
	}
	best := candidates[0]
	for _, c := range candidates[1:] {
		if rank(c) < rank(best) {
			best = c
		}
	}
	return best, true
}

// options are a part's resource options, as the state has them, and the
// components and parts they refer to. used are the resources its inputs
// refer to, which it then doesn't depend on again.
func (g *generator) options(r *stateResource, used map[resource.URN]bool) (*object, []resource.URN) {
	opts := newObject()
	opts.set("parent", raw(g.vars[r.Parent]))
	needs := []resource.URN{r.Parent}
	if provider := r.providerURN(); containsURN(g.providers, provider) {
		opts.set("provider", raw(g.vars[provider]))
	} else if g.role[provider] == roleRegionProvider {
		opts.set("provider", raw(g.vars[provider]))
		needs = append(needs, provider)
	}
	var dependsOn array
	seen := map[resource.URN]bool{}
	for _, urn := range r.Dependencies {
		name, ok := g.vars[urn]
		if !ok || used[urn] || seen[urn] || urn == r.Parent {
			continue
		}
		seen[urn] = true
		dependsOn = append(dependsOn, raw(name))
		// What the program gives the module is made before it, and isn't one
		// of the module's to put in order
		if !strings.HasPrefix(name, "program.") {
			needs = append(needs, urn)
		}
	}
	if len(dependsOn) > 0 {
		opts.set("dependsOn", dependsOn)
	}
	if name, ok := g.vars[r.DeletedWith]; ok && r.DeletedWith != "" {
		opts.set("deletedWith", raw(name))
		if !strings.HasPrefix(name, "program.") {
			needs = append(needs, r.DeletedWith)
		}
	}
	if r.Protect {
		opts.set("protect", literal{true})
	}
	if r.RetainOnDelete {
		opts.set("retainOnDelete", literal{true})
	}
	if len(r.IgnoreChanges) > 0 {
		opts.set("ignoreChanges", stringList(r.IgnoreChanges))
	}
	if len(r.ReplaceOnChanges) > 0 {
		opts.set("replaceOnChanges", stringList(r.ReplaceOnChanges))
	}
	if len(r.AdditionalSecretOutputs) > 0 {
		opts.set("additionalSecretOutputs", stringList(r.AdditionalSecretOutputs))
	}
	if t := r.CustomTimeouts; t != nil && (t.Create > 0 || t.Update > 0 || t.Delete > 0) {
		timeouts := newObject()
		for _, entry := range []struct {
			key     string
			seconds float64
		}{{"create", t.Create}, {"update", t.Update}, {"delete", t.Delete}} {
			if entry.seconds > 0 {
				timeouts.set(entry.key, literal{fmt.Sprintf("%gs", entry.seconds)})
			}
		}
		opts.set("customTimeouts", timeouts)
	}
	return opts, needs
}

func stringList(values []string) array {
	result := make(array, len(values))
	for i, value := range values {
		result[i] = literal{value}
	}
	return result
}

// uses is what of the program's own uses a component or a part, which the
// program then takes from what the module returns
func (g *generator) uses() []string {
	var result []string
	for _, r := range g.resources {
		if g.role[r.URN] != roleProgram || !r.Custom || strings.HasPrefix(r.Type, "pulumi:providers:") {
			continue
		}
		var names []string
		for _, dependency := range r.Dependencies {
			if role := g.role[dependency]; role == roleComponent || role == rolePart {
				names = append(names, dependency.Name())
			}
		}
		if len(names) > 0 {
			result = append(result, fmt.Sprintf("%s uses %s", r.name(), strings.Join(names, ", ")))
		}
	}
	return result
}
