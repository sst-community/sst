package eject

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
)

// One module for every stack of a project. Each stack's state is read on
// its own, and what the module makes is lined up across them by URN, which
// is the same in each stack but for the stack's name. What's the same in
// every stack is written as it is; a plain value that isn't is read from
// each stack's config; one with a reference in it is picked by stack in the
// code; and what only some stacks have is made only on those.

// ejector writes the module from every stack's state
type ejector struct {
	opts   Options
	stacks []*generator
	// Pulumi's packages the parts are from, by the name they're imported as
	imports map[string]string
	used    map[string]bool
	// Whether a function has the comment on the build to switch to
	nodeBuild bool
	// Whether a part was made with a provider SST makes for a region
	usesRegionProvider bool
	// Whether a path is written from the project's folder
	usesPath bool
	// Each Worker's last build, copied beside the module
	files []CopiedFile
	// What the module makes, by its URN without its stack and project, in
	// the order the stacks have them: its name, and the stacks it's in
	order []string
	names map[string]string
	in    map[string][]int
	// The program's own providers and the program's own resources SST's
	// components are in, which the module's function is given, by the same
	// key: the name it's given by
	providerOrder []string
	providerArgs  map[string]string
	parentOrder   []string
	parentArgs    map[string]string
	// What it is, for what the eject says
	takes map[string]string
}

// decl is how one stack has something the module makes
type decl struct {
	key    string
	r      *stateResource
	kind   role
	parent string
	// How the module refers to the program's own resource it's in
	programParent string
	// For a part
	class    string
	comment  string
	args     *object
	opts     *object
	external bool
	id       expr
	// What it refers to, by key
	needs []string
}

// keyOf is a URN without its stack and project, the same in every stack
func keyOf(urn resource.URN) string {
	parts := strings.SplitN(string(urn), "::", 3)
	if len(parts) < 3 {
		return string(urn)
	}
	return parts[2]
}

// stageOf is a stack's name without its organization and project
func stageOf(stack string) string {
	return stack[strings.LastIndex(stack, "/")+1:]
}

func (e *ejector) unique(name string) string {
	result := name
	for n := 2; e.used[result]; n++ {
		result = fmt.Sprintf("%s%d", name, n)
	}
	e.used[result] = true
	return result
}

// declares is whether the module makes a resource of this stack
func (g *generator) declares(r *stateResource) bool {
	switch g.role[r.URN] {
	case roleComponent, rolePart:
		return true
	case roleRegionProvider:
		return g.shared.usesRegionProvider
	}
	return false
}

// name gives what the module makes a name, and each stack the names it
// refers to them by
func (e *ejector) name() {
	for _, g := range e.stacks {
		for _, r := range g.resources {
			if g.role[r.URN] != rolePart {
				continue
			}
			pkg, _, _ := strings.Cut(r.Type, ":")
			if _, ok := e.imports[pkg]; !ok {
				alias := varName(pkg)
				e.imports[pkg] = alias
				e.used[alias] = true
			}
		}
	}
	if e.usesRegionProvider {
		e.imports["aws"] = "aws"
		e.used["aws"] = true
	}
	for i, g := range e.stacks {
		for _, urn := range g.providers {
			key := keyOf(urn)
			if _, ok := e.providerArgs[key]; !ok {
				e.providerArgs[key] = e.unique(varName(urn.Name()))
				e.providerOrder = append(e.providerOrder, key)
				e.takes["providers."+e.providerArgs[key]] = fmt.Sprintf("the program's %q provider (%s)", urn.Name(), urn.Type())
			}
		}
		for _, urn := range g.parents {
			key := keyOf(urn)
			if _, ok := e.parentArgs[key]; !ok {
				e.parentArgs[key] = e.unique(varName(urn.Name()))
				e.parentOrder = append(e.parentOrder, key)
				e.takes["parents."+e.parentArgs[key]] = fmt.Sprintf("the program's %q (%s), which SST's components are in", urn.Name(), urn.Type())
			}
		}
		for _, r := range g.resources {
			if !g.declares(r) {
				continue
			}
			key := keyOf(r.URN)
			if _, ok := e.names[key]; !ok {
				name := varName(r.name())
				if g.role[r.URN] == roleRegionProvider {
					name = varName("aws " + strings.TrimPrefix(r.name(), regionProviderPrefix))
				}
				e.names[key] = e.unique(name)
				e.order = append(e.order, key)
			}
			e.in[key] = append(e.in[key], i)
		}
	}
	for _, g := range e.stacks {
		for _, urn := range g.providers {
			g.vars[urn] = "program.providers." + e.providerArgs[keyOf(urn)]
		}
		for _, urn := range g.parents {
			g.vars[urn] = "program.parents." + e.parentArgs[keyOf(urn)]
		}
		for _, r := range g.resources {
			if g.declares(r) {
				g.vars[r.URN] = e.ref(keyOf(r.URN))
			}
		}
	}
}

// conditional is whether only some stacks have it
func (e *ejector) conditional(key string) bool {
	return len(e.in[key]) < len(e.stacks)
}

// ref is how the module refers to what it makes: with a ! where only some
// stacks have it, as it's referred to only where they do
func (e *ejector) ref(key string) string {
	if e.conditional(key) {
		return e.names[key] + "!"
	}
	return e.names[key]
}

// module is sst-ejected.ts
func (e *ejector) module() (string, error) {
	// How each stack has each thing the module makes
	decls := map[string][]*decl{}
	for _, key := range e.order {
		decls[key] = make([]*decl, len(e.stacks))
	}
	for i, g := range e.stacks {
		for _, r := range g.resources {
			if !g.declares(r) {
				continue
			}
			d, err := g.decl(r)
			if err != nil {
				if len(e.stacks) > 1 {
					return "", fmt.Errorf("The %q stack: %w", g.plan.Name, err)
				}
				return "", err
			}
			decls[keyOf(r.URN)][i] = d
		}
	}

	m := &merger{stacks: e.stacks, keys: map[string]bool{}}
	type merged struct {
		key   string
		code  string
		needs []string
		group string
	}
	var groups []string
	byGroup := map[string][]merged{}
	children := map[string][]string{}
	var providers []merged
	for _, key := range e.order {
		in := e.in[key]
		present := make([]*decl, len(in))
		for j, i := range in {
			present[j] = decls[key][i]
		}
		first := present[0]
		var needs []string
		seen := map[string]bool{}
		for _, d := range present {
			for _, need := range d.needs {
				if !seen[need] && need != key {
					seen[need] = true
					needs = append(needs, need)
				}
			}
		}
		code, err := e.declaration(m, key, in, present)
		if err != nil {
			return "", err
		}
		if first.kind == roleRegionProvider {
			providers = append(providers, merged{key: key, code: code})
			continue
		}
		// The component of the program's top level it's in
		g := e.stacks[in[0]]
		top := first.r
		for g.role[top.Parent] == roleComponent {
			top = g.byURN[top.Parent]
		}
		group := keyOf(top.URN)
		if _, ok := byGroup[group]; !ok {
			groups = append(groups, group)
		}
		byGroup[group] = append(byGroup[group], merged{key: key, code: code, needs: needs, group: group})
		if first.parent != "" {
			children[first.parent] = append(children[first.parent], key)
		}
	}

	var body strings.Builder
	written := map[string]bool{}
	if len(providers) > 0 {
		body.WriteString("\n" + comment("The AWS providers SST made for a region, which its components took.", "  "))
		for _, p := range providers {
			body.WriteString(p.code)
			written[p.key] = true
		}
	}
	left := 0
	for _, group := range groups {
		left += len(byGroup[group])
	}
	for left > 0 {
		progress := false
		for _, group := range groups {
			for _, d := range byGroup[group] {
				if written[d.key] || !allWritten(d.needs, written) {
					continue
				}
				body.WriteString("\n" + d.code)
				written[d.key] = true
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
	var parts func(key string) *object
	parts = func(key string) *object {
		result := newObject()
		for _, child := range children[key] {
			k := partKey(nameOfKey(key), nameOfKey(child))
			for n := 2; result.values[k] != nil; n++ {
				k = fmt.Sprintf("%s%d", partKey(nameOfKey(key), nameOfKey(child)), n)
			}
			if len(children[child]) > 0 || e.kindOf(child) == roleComponent {
				result.set(k, parts(child))
			} else {
				result.set(k, raw(e.names[child]))
			}
		}
		return result
	}
	result := newObject()
	for _, group := range groups {
		result.set(nameOfKey(group), parts(group))
	}

	var stacks []string
	for _, g := range e.stacks {
		stacks = append(stacks, g.plan.Name)
	}
	conditional := false
	for _, key := range e.order {
		if e.conditional(key) {
			conditional = true
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "// Written by sst eject on %s, from the state of the %s of %s.\n", e.opts.Date, stacksPhrase(stacks), e.opts.Project)
	b.WriteString("// SST's components are Pulumi components here, of the same type and name,\n")
	b.WriteString("// and their parts are Pulumi's own resources, with the inputs they were\n")
	b.WriteString("// last deployed with, so nothing changes in the cloud when this takes their\n")
	b.WriteString("// place. It's yours to change from here.\n")
	if m.usesConfig {
		b.WriteString("//\n")
		if len(stacks) > 1 {
			b.WriteString(comment(fmt.Sprintf("Secret inputs, and values that aren't the same in every stack, are in each stack's config, under %s.", ConfigNamespace), ""))
		} else {
			fmt.Fprintf(&b, "// Secret inputs are in the stack's config, under %s.\n", ConfigNamespace)
		}
	}
	if e.usesPath {
		b.WriteString("import * as path from \"path\";\n")
	}
	b.WriteString("import * as pulumi from \"@pulumi/pulumi\";\n")
	pkgs := make([]string, 0, len(e.imports))
	for pkg := range e.imports {
		pkgs = append(pkgs, pkg)
	}
	sort.Strings(pkgs)
	for _, pkg := range pkgs {
		fmt.Fprintf(&b, "import * as %s from %s;\n", e.imports[pkg], quote("@pulumi/"+pkg))
	}
	if m.usesConfig {
		fmt.Fprintf(&b, "\nconst config = new pulumi.Config(%s);\n", quote(ConfigNamespace))
	}
	if e.usesPath {
		b.WriteString(projectRootHelper)
	}
	if conditional {
		b.WriteString(onStackHelper)
	}
	if m.usesByStack {
		b.WriteString(byStackHelper)
	}
	if e.usesRegionProvider {
		b.WriteString(regionProviderHelper)
	}
	b.WriteString("\n/**\n")
	b.WriteString(" * Makes what SST's components made, and returns each one's parts by\n")
	b.WriteString(" * component, for the program to use in place of their outputs.\n")
	b.WriteString(" */\n")
	if len(e.providerOrder) == 0 && len(e.parentOrder) == 0 {
		b.WriteString("export function ejected() {\n")
	} else {
		b.WriteString("export function ejected(program: {\n")
		if len(e.providerOrder) > 0 {
			b.WriteString("  /** The program's own providers SST's components were given. */\n")
			b.WriteString("  providers: {\n")
			for _, key := range e.providerOrder {
				fmt.Fprintf(&b, "    %s: pulumi.ProviderResource;\n", e.providerArgs[key])
			}
			b.WriteString("  };\n")
		}
		if len(e.parentOrder) > 0 {
			b.WriteString("  /** The program's own components SST's components are in. */\n")
			b.WriteString("  parents: {\n")
			for _, key := range e.parentOrder {
				fmt.Fprintf(&b, "    %s: pulumi.Resource;\n", e.parentArgs[key])
			}
			b.WriteString("  };\n")
		}
		b.WriteString("}) {\n")
	}
	if len(stacks) == 1 {
		fmt.Fprintf(&b, "  if (pulumi.getStack() !== %s)\n", quote(stacks[0]))
	} else {
		quoted := make([]string, len(stacks))
		for i, stack := range stacks {
			quoted[i] = quote(stack)
		}
		fmt.Fprintf(&b, "  if (![%s].includes(pulumi.getStack()))\n", strings.Join(quoted, ", "))
	}
	fmt.Fprintf(&b, "    throw new Error(\n      `%s was written from the state of the %s, and this is the \"${pulumi.getStack()}\" stack.`,\n    );\n", ModuleFile, templateText(stacksPhrase(stacks)))
	b.WriteString(body.String())
	b.WriteString("\n  return " + result.ts("  ") + ";\n}\n")
	return b.String(), nil
}

// stacksPhrase is `"dev" stack`, or `"dev" and "prod" stacks`
func stacksPhrase(stacks []string) string {
	quoted := make([]string, len(stacks))
	for i, stack := range stacks {
		quoted[i] = quote(stack)
	}
	if len(quoted) == 1 {
		return quoted[0] + " stack"
	}
	return strings.Join(quoted[:len(quoted)-1], ", ") + " and " + quoted[len(quoted)-1] + " stacks"
}

func nameOfKey(key string) string {
	return key[strings.LastIndex(key, "::")+2:]
}

func (e *ejector) kindOf(key string) role {
	g := e.stacks[e.in[key][0]]
	for _, r := range g.resources {
		if keyOf(r.URN) == key {
			return g.role[r.URN]
		}
	}
	return roleProgram
}

func allWritten(keys []string, written map[string]bool) bool {
	for _, key := range keys {
		if !written[key] {
			return false
		}
	}
	return true
}

// declaration is the code that makes one thing, in the stacks that have it
func (e *ejector) declaration(m *merger, key string, in []int, present []*decl) (string, error) {
	first := present[0]
	name := e.names[key]
	var stacks []string
	for _, i := range in {
		stacks = append(stacks, e.stacks[i].plan.Name)
	}
	// What makes it, written at an indent
	var build func(indent string) string
	switch first.kind {
	case roleRegionProvider:
		region := quote(strings.TrimPrefix(first.r.name(), regionProviderPrefix))
		build = func(string) string { return "regionProvider(" + region + ")" }
	case roleComponent:
		build = func(string) string {
			if first.programParent != "" {
				return fmt.Sprintf("new pulumi.ComponentResource(%s, %s, {}, { parent: %s })", quote(first.r.Type), quote(first.r.name()), first.programParent)
			}
			if first.parent == "" {
				return fmt.Sprintf("new pulumi.ComponentResource(%s, %s)", quote(first.r.Type), quote(first.r.name()))
			}
			return fmt.Sprintf("new pulumi.ComponentResource(%s, %s, {}, { parent: %s })", quote(first.r.Type), quote(first.r.name()), e.ref(first.parent))
		}
	case rolePart:
		opts := make([]expr, len(present))
		for j, d := range present {
			opts[j] = d.opts
		}
		mergedOpts, err := m.merge(in, opts, first.r.name(), true)
		if err != nil {
			return "", err
		}
		if first.external {
			ids := make([]expr, len(present))
			for j, d := range present {
				ids[j] = d.id
			}
			id, err := m.merge(in, ids, first.r.name()+".id", false)
			if err != nil {
				return "", err
			}
			build = func(indent string) string {
				return fmt.Sprintf("%s.get(%s, %s, undefined, %s)", first.class, quote(first.r.name()), id.ts(indent), mergedOpts.ts(indent))
			}
			break
		}
		args := make([]expr, len(present))
		for j, d := range present {
			args[j] = d.args
		}
		mergedArgs, err := m.merge(in, args, first.r.name(), false)
		if err != nil {
			return "", err
		}
		if mergedArgs == nil {
			mergedArgs = newObject()
		}
		build = func(indent string) string {
			line := fmt.Sprintf("new %s(%s, %s, %s)", first.class, quote(first.r.name()), mergedArgs.ts(indent), mergedOpts.ts(indent))
			if !strings.Contains(line, "\n") && len(indent)+len(line) <= width-12 {
				return line
			}
			inner := indent + "  "
			return fmt.Sprintf("new %s(\n%s%s,\n%s%s,\n%s%s,\n%s)", first.class, inner, quote(first.r.name()), inner, mergedArgs.ts(inner), inner, mergedOpts.ts(inner), indent)
		}
	}

	var b strings.Builder
	if first.kind == roleComponent && first.parent == "" {
		text := fmt.Sprintf("%s, SST's %s", first.r.name(), first.r.Type)
		if at := first.r.madeAt(); at != "" {
			text += ", made at " + at
		}
		if e.conditional(key) {
			text += ", in the " + stacksPhrase(stacks)
		}
		b.WriteString(comment(text, "  "))
	}
	for _, d := range present {
		if d.comment != "" {
			b.WriteString(d.comment)
			break
		}
	}
	if !e.conditional(key) {
		b.WriteString("  const " + name + " = " + build("  ") + ";\n")
		return b.String(), nil
	}
	quoted := make([]string, len(stacks))
	for i, stack := range stacks {
		quoted[i] = quote(stack)
	}
	b.WriteString("  const " + name + " = onStack(" + strings.Join(quoted, ", ") + ")\n")
	b.WriteString("    ? " + build("      ") + "\n")
	b.WriteString("    : undefined;\n")
	return b.String(), nil
}

// projectRootHelper is the project's folder, which a path in the project is
// written from, read as SST's components read it (context.ts): Pulumi gives
// it to a program from 3.150 or so, which runs from main's folder
const projectRootHelper = `
/** The project's folder, where Pulumi.yaml is. */
const projectRoot: string =
  (pulumi as any).getRootDirectory?.() || process.cwd();
`

const onStackHelper = `
/** Whether this is one of the stacks something is made on. */
function onStack(...stacks: string[]) {
  return stacks.includes(pulumi.getStack());
}
`

const byStackHelper = `
/** The value this stack has. */
function byStack<T>(values: Record<string, () => T>): T {
  return values[pulumi.getStack()]?.() as T;
}
`

// merger merges what each stack has of one value
type merger struct {
	stacks []*generator
	// The config keys taken
	keys        map[string]bool
	usesConfig  bool
	usesByStack bool
}

// merge is a value the stacks in `in` have, from each one's (nil where one
// doesn't have it): as it is where it's the same, from the config where
// it's a plain value or a secret, and picked by stack otherwise. path is
// where it is, for the config key. A resource's options are never read from
// the config.
func (m *merger) merge(in []int, values []expr, path string, options bool) (expr, error) {
	var present []expr
	for _, value := range values {
		if value != nil {
			present = append(present, value)
		}
	}
	if len(present) == 0 {
		return nil, nil
	}
	complete := len(present) == len(values)
	secret := false
	for _, value := range present {
		if hasSecret(value) {
			secret = true
		}
	}

	// The same shape in every stack: each of its values is merged
	if complete {
		switch first := present[0].(type) {
		case *object:
			objects := make([]*object, len(present))
			ok := true
			for i, value := range present {
				objects[i], ok = value.(*object)
				if !ok {
					break
				}
			}
			if ok {
				var keys []string
				seen := map[string]bool{}
				for _, o := range objects {
					for _, key := range o.keys {
						if !seen[key] {
							seen[key] = true
							keys = append(keys, key)
						}
					}
				}
				result := newObject()
				for _, key := range keys {
					items := make([]expr, len(objects))
					for i, o := range objects {
						items[i] = o.values[key]
					}
					item, err := m.merge(in, items, path+"."+key, options)
					if err != nil {
						return nil, err
					}
					if item != nil {
						result.set(key, item)
					}
				}
				return result, nil
			}
		case array:
			arrays := make([]array, len(present))
			ok := true
			for i, value := range present {
				arrays[i], ok = value.(array)
				if !ok || len(arrays[i]) != len(first) {
					ok = false
					break
				}
			}
			if ok {
				result := make(array, len(first))
				for index := range first {
					items := make([]expr, len(arrays))
					for i, a := range arrays {
						items[i] = a[index]
					}
					item, err := m.merge(in, items, fmt.Sprintf("%s[%d]", path, index), options)
					if err != nil {
						return nil, err
					}
					result[index] = item
				}
				return result, nil
			}
		case jsonText:
			texts := make([]expr, len(present))
			ok := true
			for i, value := range present {
				text, isText := value.(jsonText)
				if !isText || text.indent != first.indent {
					ok = false
					break
				}
				texts[i] = text.value
			}
			if ok {
				value, err := m.merge(in, texts, path, options)
				if err != nil {
					return nil, err
				}
				return jsonText{value: value, indent: first.indent, refs: !isPlain(value)}, nil
			}
		}
		if !secret {
			same := true
			for _, value := range present[1:] {
				if value.ts("") != present[0].ts("") {
					same = false
				}
			}
			if same {
				return present[0], nil
			}
		}
	}

	plainOrSecret := true
	for _, value := range present {
		if !isPlain(value) && !isSecretTree(value) {
			plainOrSecret = false
		}
	}
	if !options && plainOrSecret {
		return m.setting(in, values, path, secret, !complete), nil
	}
	if secret {
		return nil, fmt.Errorf("sst eject can't write %s, which is a secret in one stack and refers to a resource in another.", path)
	}
	result := byStack{}
	for i, value := range values {
		if value != nil {
			result.stacks = append(result.stacks, m.stacks[in[i]].plan.Name)
			result.values = append(result.values, value)
		}
	}
	m.usesByStack = true
	return result, nil
}

// setting is a value read from each stack's config, which is set there
func (m *merger) setting(in []int, values []expr, path string, secret, optional bool) expr {
	// A config key has one ":", after its namespace, and a path can have more,
	// from an object's keys, like a policy's aws:SourceAccount
	base := strings.ReplaceAll(path, ":", "_")
	key := base
	for n := 2; m.keys[key]; n++ {
		key = fmt.Sprintf("%s.%d", base, n)
	}
	m.keys[key] = true
	m.usesConfig = true
	kind := ""
	for _, value := range values {
		if value == nil {
			continue
		}
		this := "object"
		switch plain := plainValue(value).(type) {
		case string:
			// pulumi config set takes a newline off the end of what it reads,
			// which JSON keeps
			if !strings.HasSuffix(plain, "\n") {
				this = "string"
			}
		case json.Number:
			this = "number"
		case bool:
			this = "boolean"
		}
		if kind == "" {
			kind = this
		} else if kind != this {
			kind = "object"
		}
	}
	for i, value := range values {
		if value == nil {
			continue
		}
		plain := plainValue(value)
		// Read as an object, a string is set as JSON too
		text := configText(plain)
		if _, ok := plain.(string); ok && kind == "object" {
			text, _ = jsonString(plain, "", "")
		}
		m.stacks[in[i]].plan.Config = append(m.stacks[in[i]].plan.Config, Setting{
			Key:    ConfigNamespace + ":" + key,
			Value:  text,
			Secret: secret,
		})
	}
	method := map[string]string{
		"string":  "require",
		"number":  "requireNumber",
		"boolean": "requireBoolean",
		"object":  "requireObject<any>",
	}[kind]
	if secret {
		method = map[string]string{
			"string":  "requireSecret",
			"number":  "requireSecretNumber",
			"boolean": "requireSecretBoolean",
			"object":  "requireSecretObject<any>",
		}[kind]
	}
	if optional {
		method = "get" + strings.TrimPrefix(method, "require")
	}
	return configRead{key: key, method: method}
}

// isPlain is whether a value is only what it is, with no reference, secret
// or config in it
func isPlain(value expr) bool {
	switch value := value.(type) {
	case literal:
		return true
	case *object:
		for _, key := range value.keys {
			if !isPlain(value.values[key]) {
				return false
			}
		}
		return true
	case array:
		for _, item := range value {
			if !isPlain(item) {
				return false
			}
		}
		return true
	case jsonText:
		return isPlain(value.value)
	}
	return false
}

// isSecretTree is whether a value is only plain values and secrets
func isSecretTree(value expr) bool {
	switch value := value.(type) {
	case stackSecret, literal:
		return true
	case *object:
		for _, key := range value.keys {
			if !isSecretTree(value.values[key]) {
				return false
			}
		}
		return true
	case array:
		for _, item := range value {
			if !isSecretTree(item) {
				return false
			}
		}
		return true
	case jsonText:
		return isSecretTree(value.value)
	}
	return false
}

func hasSecret(value expr) bool {
	switch value := value.(type) {
	case stackSecret:
		return true
	case *object:
		for _, key := range value.keys {
			if hasSecret(value.values[key]) {
				return true
			}
		}
	case array:
		for _, item := range value {
			if hasSecret(item) {
				return true
			}
		}
	case jsonText:
		return hasSecret(value.value)
	}
	return false
}

// plainValue is what a plain value or a secret stands for: a JSON value,
// with an object's keys in order, and a string that's JSON as the string
func plainValue(value expr) any {
	switch value := value.(type) {
	case literal:
		return value.value
	case stackSecret:
		return value.value
	case *object:
		result := &orderedObject{values: map[string]any{}}
		for _, key := range value.keys {
			result.keys = append(result.keys, key)
			result.values[key] = plainValue(value.values[key])
		}
		return result
	case array:
		result := make([]any, len(value))
		for i, item := range value {
			result[i] = plainValue(item)
		}
		return result
	case jsonText:
		text, _ := jsonString(plainValue(value.value), value.indent, "")
		return text
	}
	return nil
}

// configText is a value as it's set in the config: a string as it is, and
// anything else as JSON
func configText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	text, _ := jsonString(value, "", "")
	return text
}

// jsonString is JSON for a value, an ordered object's keys in their order
// and a map's sorted, as JSON.stringify writes it with the indent
func jsonString(value any, indent, current string) (string, bool) {
	switch value := value.(type) {
	case map[string]any:
		ordered := &orderedObject{values: value, keys: sortedKeys(value)}
		return jsonString(ordered, indent, current)
	case *orderedObject:
		if len(value.keys) == 0 {
			return "{}", true
		}
		inner := current + indent
		separator := ":"
		if indent != "" {
			separator = ": "
		}
		parts := make([]string, len(value.keys))
		for i, key := range value.keys {
			part, _ := jsonString(value.values[key], indent, inner)
			parts[i] = jsQuote(key) + separator + part
		}
		if indent == "" {
			return "{" + strings.Join(parts, ",") + "}", true
		}
		return "{\n" + inner + strings.Join(parts, ",\n"+inner) + "\n" + current + "}", true
	case []any:
		if len(value) == 0 {
			return "[]", true
		}
		inner := current + indent
		parts := make([]string, len(value))
		for i, item := range value {
			parts[i], _ = jsonString(item, indent, inner)
		}
		if indent == "" {
			return "[" + strings.Join(parts, ",") + "]", true
		}
		return "[\n" + inner + strings.Join(parts, ",\n"+inner) + "\n" + current + "]", true
	case json.Number:
		return value.String(), true
	}
	return stringify(value, indent, current)
}
