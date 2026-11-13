package eject

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/sig"
)

// ConfigNamespace is where the module reads the secret inputs it was given,
// in the stack's config
const ConfigNamespace = "sst-ejected"

// ModuleFile and BuildFile are the files sst eject writes beside Pulumi.yaml
const (
	ModuleFile = "sst-ejected.ts"
	BuildFile  = "sst-ejected-build.ts"
)

// Options says what the module is written from
type Options struct {
	// The Pulumi project's name
	Project string
	// The day it's written, for the module's first line
	Date string
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

type role int

const (
	// The program's own, which the eject leaves as it is
	roleProgram role = iota
	// One of SST's components, or a component in one
	roleComponent
	// A resource a component made, which the module writes
	rolePart
	// What leaves the state
	roleRemove
	// An AWS provider SST makes for a region (`useProvider`), which the
	// module makes the same way
	roleRegionProvider
)

// SST's own resources the eject takes out of the state, with what's left of
// what they made
var ownResources = map[string]string{
	"sst:aws:BucketFiles":                  "the site's files, which stay as last deployed",
	"sst:aws:KvKeys":                       "entries in a site's or a router's key-value store, which stay as last deployed",
	"sst:aws:KvRoutesUpdate":               "a route's entry in the router's key-value store, which stays as last deployed",
	"sst:aws:DistributionInvalidation":     "an invalidation of the CDN's cache, with nothing to keep",
	"sst:aws:DistributionDeploymentWaiter": "a wait for the CDN to deploy, with nothing in the cloud",
}

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
	// The program's own providers parts were made with, which the module's
	// function is given
	providers []resource.URN
	plan      *StackPlan
	// SST's components made at the program's top level
	components []Component
	// What addEnvironment added to a function's environment after it was
	// made, by the function's name, then by the function
	envUpdates map[string]map[string]any
	addedEnv   map[resource.URN]map[string]any
}

func (g *generator) remove(r *stateResource, why string) {
	g.role[r.URN] = roleRemove
	g.plan.Remove = append(g.plan.Remove, r.URN)
	g.plan.Removed = append(g.plan.Removed, Removed{Name: r.name(), Type: r.Type, Why: why})
}

// classify says what the eject does with each resource
func (g *generator) classify() error {
	var stack resource.URN
	for _, r := range g.resources {
		g.byURN[r.URN] = r
		name := r.name()
		switch {
		case r.Delete:
			return fmt.Errorf("The stack's state has %s waiting to be deleted. Run `pulumi up` first, and eject once it's clean.", name)
		case r.PendingReplacement || r.Taint:
			return fmt.Errorf("The stack's state has %s waiting to be replaced. Run `pulumi up` first, and eject once it's clean.", name)
		}
		parent := g.role[r.Parent]
		inComponent := r.Parent != "" && parent == roleComponent
		switch {
		case r.Type == "pulumi:pulumi:Stack":
			stack = r.URN
			g.role[r.URN] = roleProgram
		case r.Type == "pulumi:providers:sst":
			g.remove(r, "SST's provider, which SST's own resources were made with")
		case r.Type == "pulumi:providers:aws" && r.Parent == stack && strings.HasPrefix(name, "AwsProvider.sst."):
			g.role[r.URN] = roleRegionProvider
		case strings.HasPrefix(r.Type, "pulumi:providers:"):
			if inComponent {
				return fmt.Errorf("%s, one of SST's components, made a provider of its own, %s, which sst eject doesn't write yet.", r.Parent.Name(), name)
			}
			g.role[r.URN] = roleProgram
		case !r.Custom && r.Type == "sst:sst:LinkRef":
			g.remove(r, "a record of what links to "+strings.TrimSuffix(name, "LinkRef")+", with nothing in the cloud")
		case !r.Custom && (strings.HasPrefix(r.Type, "sst:") || inComponent):
			if r.Parent != stack && !inComponent {
				return fmt.Errorf("%s, one of SST's components, is in %s, a component of the program's, which sst eject doesn't write yet.", name, r.Parent.Name())
			}
			if dev, _ := recordedFunction(r)["dev"].(bool); dev {
				return fmt.Errorf("The %q stack was last deployed by sst dev, so its functions run the stub that sends their calls to your machine. Run `pulumi up` first, which deploys their code, then eject.", g.plan.Name)
			}
			g.role[r.URN] = roleComponent
			if !inComponent {
				g.components = append(g.components, Component{Name: name, Type: r.Type, MadeAt: r.madeAt()})
			}
		case r.Custom && r.providerURN().Type() == "pulumi:providers:sst" && r.Type == "sst:aws:FunctionEnvironmentUpdate":
			// addEnvironment's: what it added goes in the function's
			// environment in the module
			fn, _ := r.Inputs["functionName"].(string)
			added, _ := revealed(r.Inputs["environment"]).(map[string]any)
			if fn == "" {
				return fmt.Errorf("%s (%s) names no function.", name, r.Type)
			}
			if g.envUpdates[fn] == nil {
				g.envUpdates[fn] = map[string]any{}
			}
			for key, value := range added {
				g.envUpdates[fn][key] = value
			}
			g.remove(r, "what addEnvironment added to "+fn+"'s environment, which the module puts in its environment")
		case r.Custom && r.providerURN().Type() == "pulumi:providers:sst":
			why, ok := ownResources[r.Type]
			if !ok {
				return fmt.Errorf("%s (%s) is one of SST's own resources, which sst eject doesn't take out of the state yet.", name, r.Type)
			}
			g.remove(r, why)
		case r.Custom && r.Parent == stack && r.Type == "random:index/randomBytes:RandomBytes" && name == "LambdaEncryptionKey":
			g.remove(r, "the key SST encrypts links with, with nothing in the cloud: each function has it in its environment")
		case r.Custom && r.Parent == stack && strings.HasPrefix(name, "DevBridgeCode"):
			return fmt.Errorf("The %q stack has been deployed by sst dev, and its state still has the stub's code. Run `pulumi up` first, then eject.", g.plan.Name)
		case r.Custom && inComponent:
			if built(r) {
				// SST keeps a function's source maps on delete, and not its code
				if r.RetainOnDelete {
					g.remove(r, "a source map of SST's build, which stays at s3://"+r.ID)
				} else {
					g.remove(r, "the code SST built, which stays at s3://"+r.ID+" while the function points at it: delete it once the function has a build of its own")
				}
			} else {
				g.role[r.URN] = rolePart
			}
		default:
			g.role[r.URN] = roleProgram
		}
	}
	// What addEnvironment added, by the function it's added to
	for fn, added := range g.envUpdates {
		var found *stateResource
		for _, r := range g.resources {
			if g.role[r.URN] == rolePart && r.Type == "aws:lambda/function:Function" && (r.ID == fn || r.Outputs["name"] == fn) {
				found = r
			}
		}
		if found == nil {
			return fmt.Errorf("addEnvironment added to the environment of %s, which isn't one of the functions SST's components made here.", fn)
		}
		g.addedEnv[found.URN] = added
		keys := sortedKeys(added)
		g.plan.Updates = append(g.plan.Updates, fmt.Sprintf("%s's environment gets %s, which addEnvironment added after it was made", found.name(), strings.Join(keys, ", ")))
	}
	sort.Strings(g.plan.Updates)
	// A part made with a provider of the program's is given it by name, and
	// one SST made isn't written yet
	for _, r := range g.resources {
		if g.role[r.URN] != rolePart {
			continue
		}
		provider := g.byURN[r.providerURN()]
		if provider == nil {
			return fmt.Errorf("%s was made with a provider that isn't in the state.", r.name())
		}
		if isDefaultProvider(provider) {
			continue
		}
		if g.role[provider.URN] == roleRegionProvider {
			g.shared.usesRegionProvider = true
			continue
		}
		if g.role[provider.URN] != roleProgram {
			return fmt.Errorf("%s was made with %s, which sst eject doesn't write yet.", r.name(), provider.name())
		}
		if !containsURN(g.providers, provider.URN) {
			g.providers = append(g.providers, provider.URN)
		}
	}
	// A component with nothing in it, like a DevCommand, which only tells
	// sst dev what to run, has nothing in the cloud either, and leaves. Its
	// components go first, as they may be empty once theirs have gone.
	for i := len(g.resources) - 1; i >= 0; i-- {
		r := g.resources[i]
		if g.role[r.URN] != roleComponent || g.hasChildren(r.URN) {
			continue
		}
		why := "a component with nothing in it, and nothing in the cloud"
		if r.Type == "sst:x:DevCommand" {
			why = "a dev command for sst dev, with nothing in the cloud"
		}
		g.remove(r, why)
		for j, c := range g.components {
			if c.Name == r.name() && c.Type == r.Type {
				g.components = append(g.components[:j], g.components[j+1:]...)
				break
			}
		}
	}
	// A default provider that only what leaves the state used, like
	// random's for the links' key, goes too, as the next deploy would
	// delete it
	inUse := map[resource.URN]bool{}
	for _, r := range g.resources {
		if g.role[r.URN] != roleRemove && r.Provider != "" {
			inUse[r.providerURN()] = true
		}
	}
	for _, r := range g.resources {
		if strings.HasPrefix(r.Type, "pulumi:providers:") && g.role[r.URN] == roleProgram && isDefaultProvider(r) && !inUse[r.URN] {
			g.remove(r, "a default provider nothing else in the state uses")
		}
	}
	return nil
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

// recordedFunction is the function one of SST's components recorded for
// SST's CLI, or nil
func recordedFunction(r *stateResource) map[string]any {
	if r == nil {
		return nil
	}
	record, _ := r.Outputs["_sst"].(map[string]any)
	fn, _ := record["function"].(map[string]any)
	return fn
}

// built is whether a part is a file uploaded from SST's build, like a
// function's code or its source map: an object whose source is a file
func built(r *stateResource) bool {
	if r.Type != "aws:s3/bucketObjectv2:BucketObjectv2" && r.Type != "aws:s3/bucketObject:BucketObject" {
		return false
	}
	source := revealed(r.Inputs["source"])
	kind, _ := source.(map[string]any)[sig.Key].(string)
	return kind == sig.AssetSig || kind == sig.ArchiveSig
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

// regionProviderHelper makes an AWS provider for a region as SST's
// components made it (useProvider in aws/helpers/provider.ts): from the
// stack's AWS config, with the region, so its inputs are the same
const regionProviderHelper = `
/**
 * An AWS provider for a region, as SST made it: the stack's AWS config, in
 * that region.
 */
function regionProvider(region: string) {
  const config: Record<string, any> = {};
  for (const [key, value] of Object.entries(pulumi.runtime.allConfig())) {
    const [namespace, name] = key.split(":");
    if (namespace !== "aws") continue;
    try {
      config[name] = JSON.parse(value);
    } catch {
      config[name] = value;
    }
  }
  return new aws.Provider(` + "`AwsProvider.sst.${region}`" + `, {
    ...config,
    region: region as aws.Region,
  });
}
`

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

// buildComment says how to switch a Node.js function from the last build
// SST made to one made in the program
func (g *generator) buildComment(r *stateResource) string {
	if r.Type != "aws:lambda/function:Function" {
		return ""
	}
	runtime, _ := r.Inputs["runtime"].(string)
	if !strings.HasPrefix(runtime, "nodejs") || r.Inputs["s3Key"] == nil {
		return ""
	}
	handler, _ := recordedFunction(g.byURN[r.Parent])["handler"].(string)
	if handler == "" {
		return ""
	}
	g.shared.nodeBuild = true
	return comment(fmt.Sprintf("The last build SST made of %s, in the asset bucket. To build it here, take out handler, s3Bucket and s3Key, and add ...nodeBuild(%s) from ./%s. SST_KEY and SST_KEY_FILE in its environment are for the links in SST's build: give the handler what it links to in its environment instead.", handler, quote(handler), strings.TrimSuffix(BuildFile, ".ts")), "  ")
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
		at := valueAt{r: r, path: []string{key}, deps: g.declared(r.PropertyDependencies[key]), used: used}
		value, err := g.value(values[key], key, at)
		if err != nil {
			return nil, err
		}
		result.set(key, value)
	}
	return result, nil
}

// withEnvironment is a function's environment input with what's added to
// its variables. If either has a secret, the variables are a secret.
func withEnvironment(environment any, added map[string]any) any {
	result := map[string]any{}
	if given, ok := environment.(map[string]any); ok {
		for key, value := range given {
			result[key] = value
		}
	}
	variables := map[string]any{}
	secret := false
	given := result["variables"]
	if wrapped, ok := given.(map[string]any); ok && wrapped[sig.Key] == sig.Secret {
		secret = true
		given = revealed(wrapped)
	}
	if given, ok := given.(map[string]any); ok {
		for key, value := range given {
			variables[key] = value
		}
	}
	for key, value := range added {
		if wrapped, ok := value.(map[string]any); ok && wrapped[sig.Key] == sig.Secret {
			secret = true
			value = revealed(wrapped)
		}
		variables[key] = value
	}
	if !secret {
		result["variables"] = variables
		return result
	}
	text, _ := marshal(variables)
	result["variables"] = map[string]any{sig.Key: sig.Secret, "plaintext": string(text)}
	return result
}

// declared are those of the URNs the module has a name for
func (g *generator) declared(urns []resource.URN) []resource.URN {
	var result []resource.URN
	for _, urn := range urns {
		if _, ok := g.vars[urn]; ok && !strings.HasPrefix(g.vars[urn], "providers.") {
			result = append(result, urn)
		}
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
		if ref := g.match(text, key, at); ref != nil {
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
	if len(text) < 8 || len(at.deps) == 0 {
		return nil
	}
	all := g.candidates(at.deps)
	var exact []candidate
	for _, c := range all {
		if c.value == text {
			exact = append(exact, c)
		}
	}
	if best, ok := bestOf(exact, key); ok {
		at.used[best.urn] = true
		return raw(g.vars[best.urn] + "." + best.key)
	}
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
		if !ok || strings.HasPrefix(name, "providers.") || used[urn] || seen[urn] || urn == r.Parent {
			continue
		}
		seen[urn] = true
		dependsOn = append(dependsOn, raw(name))
		needs = append(needs, urn)
	}
	if len(dependsOn) > 0 {
		opts.set("dependsOn", dependsOn)
	}
	if name, ok := g.vars[r.DeletedWith]; ok && r.DeletedWith != "" && !strings.HasPrefix(name, "providers.") {
		opts.set("deletedWith", raw(name))
		needs = append(needs, r.DeletedWith)
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
