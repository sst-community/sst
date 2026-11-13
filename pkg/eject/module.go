package eject

import (
	"bytes"
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
	// The stack's name, without its organization and project
	Stack string
	// The day it's written, for the module's first line
	Date string
}

// Plan is what an eject writes and what it takes out of the state, worked
// out from the state before anything is changed
type Plan struct {
	// sst-ejected.ts
	Module string
	// sst-ejected-build.ts, or "" when no function runs on Node.js
	Build string
	// What's set in the stack's config, under ConfigNamespace
	Secrets []Secret
	// What leaves the state, in the state's order
	Remove []resource.URN
	// SST's components, now in the module, for what the eject says
	Components []Component
	// What leaves the state, and why, for what the eject says
	Removed []Removed
	// The program's own resources that use a component, for what the eject
	// says
	Uses []string
	// What the module has that the state doesn't, which the first `pulumi up`
	// updates in place to what it already is in the cloud
	Updates []string
}

// Secret is a secret input, as it's set in the stack's config: a string as
// it is, and anything else as JSON
type Secret struct {
	Key   string
	Value string
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

type generator struct {
	opts      Options
	resources []*stateResource
	byURN     map[resource.URN]*stateResource
	role      map[resource.URN]role
	// The names of components, parts and the program's providers in the
	// module
	vars map[resource.URN]string
	used map[string]bool
	// Pulumi's packages the parts are from, by the name they're imported as
	imports map[string]string
	// The program's own providers parts were made with, which the module's
	// function is given
	providers []resource.URN
	plan      *Plan
	// Whether a function has the comment on the build to switch to
	nodeBuild bool
	// What addEnvironment added to a function's environment after it was
	// made, by the function's name, then by the function
	envUpdates map[string]map[string]any
	addedEnv   map[resource.URN]map[string]any
	// Whether a part was made with a provider SST makes for a region
	usesRegionProvider bool
}

// Build works out the eject from the stack's state, read with its secrets
// shown, and writes the module. It refuses a state it can't eject without a
// change in the cloud, saying why.
func Build(shown []byte, opts Options) (*Plan, error) {
	parsed, err := readExport(shown)
	if err != nil {
		return nil, err
	}
	if len(parsed.Deployment.PendingOperations) > 0 {
		return nil, fmt.Errorf("The stack has operations Pulumi didn't finish, like a deploy that was stopped. Run `pulumi refresh` first, and eject once it's clean.")
	}
	g := &generator{
		opts:       opts,
		resources:  parsed.Deployment.Resources,
		byURN:      map[resource.URN]*stateResource{},
		role:       map[resource.URN]role{},
		vars:       map[resource.URN]string{},
		used:       map[string]bool{"pulumi": true, "secrets": true, "providers": true, "ejected": true},
		imports:    map[string]string{},
		plan:       &Plan{},
		envUpdates: map[string]map[string]any{},
		addedEnv:   map[resource.URN]map[string]any{},
	}
	if err := g.classify(); err != nil {
		return nil, err
	}
	if len(g.plan.Components) == 0 {
		return nil, fmt.Errorf("The %q stack has none of SST's components, so there's nothing to eject.", opts.Stack)
	}
	if err := g.name(); err != nil {
		return nil, err
	}
	module, err := g.module()
	if err != nil {
		return nil, err
	}
	g.plan.Module = module
	if g.nodeBuild {
		g.plan.Build = buildModule
	}
	g.plan.Uses = g.uses()
	return g.plan, nil
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
				return fmt.Errorf("The %q stack was last deployed by sst dev, so its functions run the stub that sends their calls to your machine. Run `pulumi up` first, which deploys their code, then eject.", g.opts.Stack)
			}
			g.role[r.URN] = roleComponent
			if !inComponent {
				g.plan.Components = append(g.plan.Components, Component{Name: name, Type: r.Type, MadeAt: r.madeAt()})
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
			return fmt.Errorf("The %q stack has been deployed by sst dev, and its state still has the stub's code. Run `pulumi up` first, then eject.", g.opts.Stack)
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
			g.usesRegionProvider = true
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
		for j, c := range g.plan.Components {
			if c.Name == r.name() && c.Type == r.Type {
				g.plan.Components = append(g.plan.Components[:j], g.plan.Components[j+1:]...)
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

// name gives each component, part and provider of the program's a name in
// the module
func (g *generator) name() error {
	for _, r := range g.resources {
		if g.role[r.URN] != rolePart {
			continue
		}
		pkg, _, _ := strings.Cut(r.Type, ":")
		if _, ok := g.imports[pkg]; !ok {
			alias := varName(pkg)
			g.imports[pkg] = alias
			g.used[alias] = true
		}
	}
	for _, urn := range g.providers {
		g.vars[urn] = "providers." + g.unique(varName(urn.Name()))
	}
	for _, r := range g.resources {
		if role := g.role[r.URN]; role == roleComponent || role == rolePart {
			g.vars[r.URN] = g.unique(varName(r.name()))
		}
	}
	if g.usesRegionProvider {
		g.imports["aws"] = "aws"
		g.used["aws"] = true
		g.used["regionProvider"] = true
		for _, r := range g.resources {
			if g.role[r.URN] == roleRegionProvider {
				g.vars[r.URN] = g.unique(varName("aws " + strings.TrimPrefix(r.name(), "AwsProvider.sst.")))
			}
		}
	}
	return nil
}

func (g *generator) unique(name string) string {
	result := name
	for n := 2; g.used[result]; n++ {
		result = fmt.Sprintf("%s%d", name, n)
	}
	g.used[result] = true
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

// module is sst-ejected.ts
func (g *generator) module() (string, error) {
	// Each declaration, with what it refers to, which has to come before
	// it, grouped by the component of the program's it's in
	type declaration struct {
		urn   resource.URN
		code  string
		needs []resource.URN
	}
	top := func(r *stateResource) *stateResource {
		for g.role[r.Parent] == roleComponent {
			r = g.byURN[r.Parent]
		}
		return r
	}
	var groups []resource.URN
	declarations := map[resource.URN][]declaration{}
	children := map[resource.URN][]*stateResource{}
	for _, r := range g.resources {
		role := g.role[r.URN]
		if role != roleComponent && role != rolePart {
			continue
		}
		var d declaration
		switch role {
		case roleComponent:
			d = declaration{urn: r.URN, code: g.component(r)}
			if g.role[r.Parent] == roleComponent {
				d.needs = []resource.URN{r.Parent}
				children[r.Parent] = append(children[r.Parent], r)
			} else {
				groups = append(groups, r.URN)
			}
		case rolePart:
			code, needs, err := g.part(r)
			if err != nil {
				return "", err
			}
			d = declaration{urn: r.URN, code: code, needs: needs}
			children[r.Parent] = append(children[r.Parent], r)
		}
		group := top(r).URN
		declarations[group] = append(declarations[group], d)
	}
	var body strings.Builder
	written := map[resource.URN]bool{}
	left := len(g.vars) - len(g.providers)
	// SST's providers for a region come first: they need nothing
	for _, r := range g.resources {
		if _, ok := g.vars[r.URN]; ok && g.role[r.URN] == roleRegionProvider {
			if left == len(g.vars)-len(g.providers) {
				body.WriteString("\n" + comment("The AWS providers SST made for a region, which its components took.", "  "))
			}
			fmt.Fprintf(&body, "  const %s = regionProvider(%s);\n", g.vars[r.URN], quote(strings.TrimPrefix(r.name(), "AwsProvider.sst.")))
			written[r.URN] = true
			left--
		}
	}
	for left > 0 {
		progress := false
		for _, group := range groups {
			for _, d := range declarations[group] {
				if written[d.urn] || !all(d.needs, written) {
					continue
				}
				body.WriteString("\n" + d.code)
				written[d.urn] = true
				left--
				progress = true
			}
		}
		if !progress {
			return "", fmt.Errorf("the state's resources depend on each other in a circle")
		}
	}

	// What it returns: each component's parts, by the names its component
	// gave them, with a component in it as one of its parts
	var parts func(r *stateResource) *object
	parts = func(r *stateResource) *object {
		result := newObject()
		for _, child := range children[r.URN] {
			key := partKey(r.name(), child.name())
			for n := 2; result.values[key] != nil; n++ {
				key = fmt.Sprintf("%s%d", partKey(r.name(), child.name()), n)
			}
			if g.role[child.URN] == roleComponent {
				result.set(key, parts(child))
			} else {
				result.set(key, raw(g.vars[child.URN]))
			}
		}
		return result
	}
	result := newObject()
	for _, urn := range groups {
		result.set(urn.Name(), parts(g.byURN[urn]))
	}

	var b strings.Builder
	fmt.Fprintf(&b, "// Written by sst eject on %s, from the state of the %q stack of %s.\n", g.opts.Date, g.opts.Stack, g.opts.Project)
	b.WriteString("// SST's components are Pulumi components here, of the same type and name,\n")
	b.WriteString("// and their parts are Pulumi's own resources, with the inputs they were\n")
	b.WriteString("// last deployed with, so nothing changes in the cloud when this takes their\n")
	b.WriteString("// place. It's yours to change from here.\n")
	if len(g.plan.Secrets) > 0 {
		b.WriteString("//\n")
		fmt.Fprintf(&b, "// Secret inputs are in the stack's config, under %s.\n", ConfigNamespace)
	}
	b.WriteString("import * as pulumi from \"@pulumi/pulumi\";\n")
	pkgs := make([]string, 0, len(g.imports))
	for pkg := range g.imports {
		pkgs = append(pkgs, pkg)
	}
	sort.Strings(pkgs)
	for _, pkg := range pkgs {
		fmt.Fprintf(&b, "import * as %s from %s;\n", g.imports[pkg], quote("@pulumi/"+pkg))
	}
	if len(g.plan.Secrets) > 0 {
		fmt.Fprintf(&b, "\nconst secrets = new pulumi.Config(%s);\n", quote(ConfigNamespace))
	}
	if g.usesRegionProvider {
		b.WriteString(regionProviderHelper)
	}
	b.WriteString("\n/**\n")
	b.WriteString(" * Makes what SST's components made, and returns each one's parts by\n")
	b.WriteString(" * component, for the program to use in place of their outputs.\n")
	b.WriteString(" */\n")
	if len(g.providers) == 0 {
		b.WriteString("export function ejected() {\n")
	} else {
		b.WriteString("export function ejected(providers: {\n")
		for _, urn := range g.providers {
			fmt.Fprintf(&b, "  %s: pulumi.ProviderResource;\n", strings.TrimPrefix(g.vars[urn], "providers."))
		}
		b.WriteString("}) {\n")
	}
	fmt.Fprintf(&b, "  if (pulumi.getStack() !== %s)\n", quote(g.opts.Stack))
	fmt.Fprintf(&b, "    throw new Error(\n      `%s is the %s stack's, from its state, and this is the \"${pulumi.getStack()}\" stack.`,\n    );\n", ModuleFile, templateText(quote(g.opts.Stack)))
	b.WriteString(body.String())
	b.WriteString("\n  return " + result.ts("  ") + ";\n}\n")
	return b.String(), nil
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

// component is the code that makes one of SST's components, as a Pulumi
// component of the same type and name
func (g *generator) component(r *stateResource) string {
	if g.role[r.Parent] == roleComponent {
		return fmt.Sprintf("  const %s = new pulumi.ComponentResource(%s, %s, {}, { parent: %s });\n", g.vars[r.URN], quote(r.Type), quote(r.name()), g.vars[r.Parent])
	}
	text := fmt.Sprintf("%s, SST's %s", r.name(), r.Type)
	if at := r.madeAt(); at != "" {
		text += ", made at " + at
	}
	return comment(text, "  ") + fmt.Sprintf("  const %s = new pulumi.ComponentResource(%s, %s);\n", g.vars[r.URN], quote(r.Type), quote(r.name()))
}

func all(urns []resource.URN, in map[resource.URN]bool) bool {
	for _, urn := range urns {
		if !in[urn] {
			return false
		}
	}
	return true
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

// part is the code that makes one part, and the components and parts it
// refers to
func (g *generator) part(r *stateResource) (string, []resource.URN, error) {
	class, err := g.class(r.Type)
	if err != nil {
		return "", nil, err
	}
	switch {
	case len(r.ReplaceWith) > 0:
		return "", nil, fmt.Errorf("%s is replaced with another resource (replaceWith), which sst eject doesn't write yet.", r.name())
	case r.ReplacementTrigger != nil:
		return "", nil, fmt.Errorf("%s has a replacement trigger, which sst eject doesn't write yet.", r.name())
	case len(r.ResourceHooks) > 0:
		return "", nil, fmt.Errorf("%s has resource hooks, which sst eject doesn't write yet.", r.name())
	case r.ViewOf != "":
		return "", nil, fmt.Errorf("%s is a view of another resource, which sst eject doesn't write yet.", r.name())
	}
	var b strings.Builder
	b.WriteString(g.buildComment(r))
	if r.External {
		opts, needs := g.options(r, nil)
		fmt.Fprintf(&b, "  const %s = %s.get(%s, %s, undefined, %s);\n", g.vars[r.URN], class, quote(r.name()), quote(r.ID), opts.ts("  "))
		return b.String(), needs, nil
	}
	used := map[resource.URN]bool{}
	args, err := g.inputs(r, used)
	if err != nil {
		return "", nil, err
	}
	opts, needs := g.options(r, used)
	for urn := range used {
		needs = append(needs, urn)
	}
	line := fmt.Sprintf("  const %s = new %s(%s, %s, %s);", g.vars[r.URN], class, quote(r.name()), args.ts("  "), opts.ts("  "))
	if !strings.Contains(line, "\n") && len(line) <= width {
		b.WriteString(line + "\n")
		return b.String(), needs, nil
	}
	fmt.Fprintf(&b, "  const %s = new %s(\n    %s,\n    %s,\n    %s,\n  );\n", g.vars[r.URN], class, quote(r.name()), args.ts("    "), opts.ts("    "))
	return b.String(), needs, nil
}

// class is the class Pulumi's package for a type has, like aws.lambda.Function
// for aws:lambda/function:Function
func (g *generator) class(token string) (string, error) {
	parts := strings.Split(token, ":")
	if len(parts) != 3 {
		return "", fmt.Errorf("sst eject can't write a resource of type %s.", token)
	}
	alias := g.imports[parts[0]]
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
	g.nodeBuild = true
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
	// Pulumi lets resources of two types have one name
	name := at.where()
	for n, taken := 2, g.secretKeys(); taken[name]; n++ {
		name = fmt.Sprintf("%s.%d", at.where(), n)
	}
	if text, ok := inner.(string); ok {
		g.plan.Secrets = append(g.plan.Secrets, Secret{Key: ConfigNamespace + ":" + name, Value: text})
		return raw("secrets.requireSecret(" + quote(name) + ")"), nil
	}
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(inner); err != nil {
		return nil, err
	}
	g.plan.Secrets = append(g.plan.Secrets, Secret{Key: ConfigNamespace + ":" + name, Value: strings.TrimSuffix(b.String(), "\n")})
	return raw("secrets.requireSecretObject<any>(" + quote(name) + ")"), nil
}

func (g *generator) secretKeys() map[string]bool {
	taken := map[string]bool{}
	for _, secret := range g.plan.Secrets {
		taken[strings.TrimPrefix(secret.Key, ConfigNamespace+":")] = true
	}
	return taken
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
