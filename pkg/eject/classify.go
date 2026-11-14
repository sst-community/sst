package eject

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/sig"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
)

// What the eject knows of SST: which of a state's resources are SST's
// components, their parts, SST's own resources and the names SST's
// TypeScript gives what it makes, and what each becomes. Keep it in step
// with the components (platform/src/components) and SST's provider
// (pkg/provider).

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

// Names SST's TypeScript gives what it makes once for a stack, which the
// eject knows them by (contract_test.go checks the components still do)
const (
	// The AWS provider SST makes for a region, followed by the region
	// (aws/helpers/provider.ts)
	regionProviderPrefix = "AwsProvider.sst."
	// The key links are encrypted with (aws/helpers/function-shared.ts)
	linkKeyName = "LambdaEncryptionKey"
	// The dev stub's code, followed by its region and bundle (aws/function.ts)
	devStubCodePrefix = "DevBridgeCode"
)

// The two of SST's own resources the module makes something in the place of
const (
	// addEnvironment's update: what it added goes in the function's
	// environment in the module
	envUpdateType = "sst:aws:FunctionEnvironmentUpdate"
	// A Worker's workers.dev URL, which the module turns on or off with
	// Pulumi's WorkersScriptSubdomain
	workerURLType = "sst:cloudflare:WorkerUrl"
)

// refusedResources are SST's own resources the eject doesn't take out of the
// state yet, by type, with why
var refusedResources = map[string]string{
	"sst:aws:OriginAccessControl": "adopting it with Pulumi's resource needs its name, which isn't in the state",
}

// ownResources are SST's own resources the eject takes out of the state, with
// what's left of what they made
var ownResources = map[string]string{
	"sst:aws:BucketFiles":                  "the site's files, which stay as last deployed",
	"sst:aws:KvKeys":                       "entries in a site's or a router's key-value store, which stay as last deployed",
	"sst:aws:KvRoutesUpdate":               "a route's entry in the router's key-value store, which stays as last deployed",
	"sst:aws:DistributionInvalidation":     "an invalidation of the CDN's cache, with nothing to keep",
	"sst:aws:DistributionDeploymentWaiter": "a wait for the CDN to deploy, with nothing in the cloud",
	"sst:aws:RdsRoleLookup":                "a wait for the role RDS gives a proxy, which is there now: nothing in the cloud",
	"sst:aws:MicrovmImagePrune":            "the deletion of a MicroVM image's old versions after each build, with nothing in the cloud: nothing deletes them after the eject, and an image keeps up to 50",
	"sst:cloudflare:DnsRecord":             "a DNS record, like the CAA record a certificate needs, which stays: SST's never deletes one",
	"sst:cloudflare:WorkerPlacement":       "where the Worker runs, which stays until its script is next uploaded, and is Cloudflare's default after that: Pulumi's Cloudflare provider can't set it",
	"sst:vercel:DnsRecord":                 "a DNS record, like the CAA record a certificate needs, which stays: SST's never deletes one",
}

// The type of Pulumi's resource the module makes a Worker's workers.dev URL
// with, in place of SST's
const subdomainType = "cloudflare:index/workersScriptSubdomain:WorkersScriptSubdomain"

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
		case r.Type == "pulumi:providers:aws" && r.Parent == stack && strings.HasPrefix(name, regionProviderPrefix):
			g.role[r.URN] = roleRegionProvider
		case strings.HasPrefix(r.Type, "pulumi:providers:"):
			if inComponent {
				return fmt.Errorf("%s, one of SST's components, made a provider of its own, %s, which sst eject doesn't write yet.", r.Parent.Name(), name)
			}
			g.role[r.URN] = roleProgram
		case !r.Custom && r.Type == "sst:sst:LinkRef":
			g.remove(r, "a record of what links to "+strings.TrimSuffix(name, "LinkRef")+", with nothing in the cloud")
		case !r.Custom && (strings.HasPrefix(r.Type, "sst:") || inComponent):
			// In one of the program's own components: the module is given it
			if r.Parent != stack && !inComponent && !containsURN(g.parents, r.Parent) {
				g.parents = append(g.parents, r.Parent)
			}
			if dev, _ := recordedFunction(r)["dev"].(bool); dev {
				return fmt.Errorf("The %q stack was last deployed by sst dev, so its functions run the stub that sends their calls to your machine. Run `pulumi up` first, which deploys their code, then eject.", g.plan.Name)
			}
			g.role[r.URN] = roleComponent
			if !inComponent {
				g.components = append(g.components, Component{Name: name, Type: r.Type, MadeAt: r.madeAt()})
			}
		case r.Custom && r.providerURN().Type() == "pulumi:providers:sst" && r.Type == envUpdateType:
			// addEnvironment's: what it added goes in the function's
			// environment in the module
			fn, _ := r.Inputs["functionName"].(string)
			added, _ := revealed(r.Inputs["environment"]).(map[string]any)
			// What's added as one secret stays a secret, each value of it
			if wrapped, ok := r.Inputs["environment"].(map[string]any); ok && wrapped[sig.Key] == sig.Secret {
				for key, value := range added {
					added[key] = asSecret(value)
				}
			}
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
		case r.Custom && r.providerURN().Type() == "pulumi:providers:sst" && r.Type == workerURLType:
			// The URL is turned on or off by Pulumi's resource in the module
			if g.scriptOf(r) == nil {
				return fmt.Errorf("%s (%s) is for a Worker's script that isn't in the state.", name, r.Type)
			}
			g.remove(r, "the Worker's workers.dev URL, which the module turns on or off with Pulumi's WorkersScriptSubdomain")
		case r.Custom && r.providerURN().Type() == "pulumi:providers:sst":
			why, ok := ownResources[r.Type]
			if !ok {
				reason := ""
				if refused, ok := refusedResources[r.Type]; ok {
					reason = ": " + refused
				}
				return fmt.Errorf("%s (%s) is one of SST's own resources, which sst eject doesn't take out of the state yet%s.", name, r.Type, reason)
			}
			g.remove(r, why)
		case r.Custom && r.Parent == stack && r.Type == "random:index/randomBytes:RandomBytes" && name == linkKeyName:
			g.remove(r, "the key SST encrypts links with, with nothing in the cloud: each function has it in its environment")
		case r.Custom && r.Parent == stack && strings.HasPrefix(name, devStubCodePrefix):
			return fmt.Errorf("The %q stack has been deployed by sst dev, and its state still has the stub's code. Run `pulumi up` first, then eject.", g.plan.Name)
		case r.Custom && inComponent:
			if built(r) {
				// In SST's bootstrap, which no stack has, it stays; in a bucket
				// of the stack's, like the program's Assets, it goes with the
				// bucket, which is emptied when it's deleted
				where := "s3://" + r.ID
				own := len(r.PropertyDependencies["bucket"]) > 0
				key, _ := revealed(r.Inputs["key"]).(string)
				switch {
				case strings.HasPrefix(key, "sourcemap/") && own:
					g.remove(r, "a source map of SST's build, which stays at "+where+" until the stack's bucket is deleted")
				case strings.HasPrefix(key, "sourcemap/"):
					g.remove(r, "a source map of SST's build, which stays at "+where)
				default:
					// A function's code, or the code a MicroVM's image was
					// built from
					what := "the code SST built, which stays at " + where + " while the function points at it: delete it once the function has a build of its own"
					if parent := g.byURN[r.Parent]; parent != nil && parent.Type == "sst:aws:MicroVm" {
						what = "the code the image was built from, which stays at " + where + " while the image points at it"
					}
					if own {
						what += ", or it goes with the stack's bucket"
					}
					g.remove(r, what)
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
	// A Worker's URL, made with Pulumi's resource where SST's was, which the
	// first `pulumi up` creates by turning the URL on or off, as it already is
	var withSubdomains []*stateResource
	for _, r := range g.resources {
		withSubdomains = append(withSubdomains, r)
		if g.role[r.URN] != roleRemove || r.Type != workerURLType {
			continue
		}
		sub := g.subdomainOf(r)
		withSubdomains = append(withSubdomains, sub)
		g.byURN[sub.URN] = sub
		g.role[sub.URN] = rolePart
		state := "off"
		if on, _ := sub.Inputs["enabled"].(bool); on {
			state = "on"
		}
		g.plan.Updates = append(g.plan.Updates, fmt.Sprintf("%s is made with Pulumi's WorkersScriptSubdomain, which turns the Worker's workers.dev URL %s, as it already is", sub.name(), state))
	}
	g.resources = withSubdomains
	sort.Strings(g.plan.Updates)
	if err := g.copyWorkers(); err != nil {
		return err
	}
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

// copyWorkers copies each Worker's code, its last build in the project's
// .sst, which a checkout of the program doesn't have, beside the module. The
// module and the state point at the copy, which has the same content, so
// nothing changes in the cloud.
func (g *generator) copyWorkers() error {
	root := g.shared.opts.Root
	if root == "" {
		return nil
	}
	work := filepath.Join(root, ".sst") + string(filepath.Separator)
	for _, r := range g.resources {
		if g.role[r.URN] != rolePart || r.Type != "cloudflare:index/workersScript:WorkersScript" {
			continue
		}
		file, _ := r.Inputs["contentFile"].(string)
		if !strings.HasPrefix(file, work) {
			continue
		}
		data, err := os.ReadFile(file)
		sum := fmt.Sprintf("%x", sha256.Sum256(data))
		if err != nil || sum != r.Inputs["contentSha256"] {
			return fmt.Errorf("%s's code is its last build, at %s, which isn't there now, or is another build. Run `pulumi up` on the %q stack, then eject.", r.name(), file, g.plan.Name)
		}
		rel := WorkerFolder + "/" + r.name() + ".js"
		// Another stack's copy of it, which has to be the same build
		copied := false
		for _, file := range g.shared.files {
			if file.Path != rel {
				continue
			}
			if file.Sum != sum {
				return fmt.Errorf("%s's code isn't the same in every stack, and sst eject keeps one build of each Worker. Deploy each stack with the same code, then eject.", r.name())
			}
			copied = true
		}
		if !copied {
			g.shared.files = append(g.shared.files, CopiedFile{Path: rel, From: file, Sum: sum})
		}
		g.workerFiles[r.URN] = rel
		if g.plan.Inputs == nil {
			g.plan.Inputs = map[resource.URN]map[string]string{}
		}
		g.plan.Inputs[r.URN] = map[string]string{"contentFile": filepath.Join(root, filepath.FromSlash(rel))}
	}
	return nil
}

// scriptOf is the Worker's script one of SST's Worker resources is for: the
// one its scriptName is from, or the one of that name
func (g *generator) scriptOf(r *stateResource) *stateResource {
	for _, urn := range r.PropertyDependencies["scriptName"] {
		if found := g.byURN[urn]; found != nil && found.Type == "cloudflare:index/workersScript:WorkersScript" {
			return found
		}
	}
	name, _ := revealed(r.Inputs["scriptName"]).(string)
	for _, found := range g.byURN {
		if found.Type == "cloudflare:index/workersScript:WorkersScript" && name != "" && (found.Inputs["scriptName"] == name || found.Outputs["scriptName"] == name) {
			return found
		}
	}
	return nil
}

// subdomainOf is Pulumi's resource for a Worker's workers.dev URL that SST's
// WorkerUrl turned on or off: of the same name, in the same Worker, with the
// script's provider
func (g *generator) subdomainOf(r *stateResource) *stateResource {
	script := g.scriptOf(r)
	parentType := ""
	if qualified := string(r.URN.QualifiedType()); strings.Contains(qualified, "$") {
		parentType = qualified[:strings.LastIndex(qualified, "$")]
	}
	enabled, _ := revealed(r.Inputs["enabled"]).(bool)
	return &stateResource{
		URN:    resource.NewURN(r.URN.Stack(), r.URN.Project(), tokens.Type(parentType), subdomainType, r.URN.Name()),
		Custom: true,
		Type:   subdomainType,
		Inputs: map[string]any{
			"accountId":  r.Inputs["accountId"],
			"scriptName": r.Inputs["scriptName"],
			"enabled":    enabled,
		},
		Parent:       r.Parent,
		Dependencies: []resource.URN{script.URN},
		Provider:     script.Provider,
		PropertyDependencies: map[string][]resource.URN{
			"accountId":  r.PropertyDependencies["accountId"],
			"scriptName": {script.URN},
		},
	}
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
	source, _ := revealed(r.Inputs["source"]).(map[string]any)
	kind, _ := source[sig.Key].(string)
	return kind == sig.AssetSig || kind == sig.ArchiveSig
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
  return new aws.Provider(` + "`" + regionProviderPrefix + "${region}`" + `, {
    ...config,
    region: region as aws.Region,
  });
}
`

// withEnvironment is a function's environment input with what's added to
// its variables. If either has a secret, the variables are a secret, and an
// environment that's a secret as a whole stays one.
func withEnvironment(environment any, added map[string]any) any {
	whole := false
	if wrapped, ok := environment.(map[string]any); ok && wrapped[sig.Key] == sig.Secret {
		whole = true
		environment = revealed(wrapped)
	}
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
	if whole {
		result["variables"] = variables
		return asSecret(result)
	}
	if !secret {
		result["variables"] = variables
		return result
	}
	result["variables"] = asSecret(variables)
	return result
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
