package pulumidev

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/auto/events"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/plugin"
	"github.com/sst/sst/v3/internal/pulumicli"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/process"
	"github.com/sst/sst/v3/pkg/server"
)

// ErrNoDevFile is why a program can't run in sst dev without its DevFile,
// which WriteDevFile can write a first one of
var ErrNoDevFile = fmt.Errorf("no %s: %w", DevFile, os.ErrNotExist)

// Written is what WriteDevFile wrote
type Written struct {
	// Path is the file's
	Path string
	// Text is what it says
	Text string
	// Here are the functions it names, to run on this machine
	Here int
	// Guessed are the functions whose handlers it guessed, by name
	Guessed []string
	// Cloud are the functions it couldn't name, which stay in the cloud
	Cloud int
}

// WriteDevFile writes a first DevFile for a program that has none, from a
// preview of its stack as sst dev deploys it: each function with its source
// handler, found or guessed, and the stack's outputs and roles, for the dev
// commands. The stack is the one named, or the one selected when it's empty.
func WriteDevFile(ctx context.Context, cfgPath, stack string) (*Written, error) {
	root := filepath.Dir(cfgPath)
	path := filepath.Join(root, DevFile)
	if _, err := os.Stat(path); err == nil {
		return nil, fmt.Errorf("%s is there already", path)
	}
	cli, err := pulumiCLI()
	if err != nil {
		return nil, err
	}
	if stack == "" {
		if stack, err = SelectedStack(cfgPath); err != nil {
			return nil, err
		}
	}
	found, err := previewStack(ctx, cli, root, stack)
	if err != nil {
		return nil, err
	}
	written := devFileText(root, StageOf(stack), found)
	// what's written is read as sst dev reads it
	if _, err := parseDevFile([]byte(written.Text)); err != nil {
		return nil, fmt.Errorf("the %s it would write can't be read: %w", DevFile, err)
	}
	if err := os.WriteFile(path, []byte(written.Text), 0644); err != nil {
		return nil, err
	}
	written.Path = path
	return written, nil
}

// previewed is what a preview of a stack says of it
type previewed struct {
	functions map[string]previewedFunction
	roles     []string
	outputs   []string
}

// previewedFunction is a function as the program makes it
type previewedFunction struct {
	runtime string
	handler string
	image   bool
	// code is its archive, as Pulumi writes it
	code map[string]interface{}
}

// previewStack previews the stack with pulumi preview, as sst dev deploys it:
// in dev, with the transform told to run nothing on this machine
func previewStack(ctx context.Context, cli, root, stack string) (*previewed, error) {
	srv, err := server.New()
	if err != nil {
		return nil, err
	}
	srv.Rpc.RegisterName("PulumiDev", &previewContract{})
	serving, stop := context.WithCancel(ctx)
	defer stop()
	go srv.Serve(serving)
	<-srv.Ready

	dir := filepath.Join(root, ".sst")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	eventlogPath := filepath.Join(dir, "pulumi."+url.PathEscape(stack)+".preview.json")
	defer os.Remove(eventlogPath)
	cmd := process.CommandContext(ctx, cli, "preview", "--non-interactive", "--stack", stack, "--event-log", eventlogPath)
	cmd.Dir = root
	cmd.Env = append(os.Environ(),
		"SST_DEV=true",
		"SST_SERVER="+srv.URL(),
		"PULUMI_SKIP_UPDATE_CHECK=true",
		"PULUMI_DEBUG_COMMANDS=true",
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	data, _ := os.ReadFile(eventlogPath)
	engineEvents := readEvents(data)
	if runErr != nil {
		problems := newDeployErrors()
		for i := range engineEvents {
			problems.add(&engineEvents[i])
		}
		message := strings.TrimPrefix(pulumicli.FirstLine(stderr.String()), "error: ")
		if len(problems.errors) > 0 {
			message = problems.errors[0].Message
		}
		if message == "" {
			message = runErr.Error()
		}
		return nil, util.NewReadableError(runErr, fmt.Sprintf("Could not preview the %q stack: %s", stack, message))
	}
	return readPreview(engineEvents), nil
}

// previewContract answers sst/pulumi's transform in a preview: nothing runs
// on this machine, and no role is changed
type previewContract struct{}

func (previewContract) Function(input *FunctionInput, output *FunctionAnswer) error {
	*output = FunctionAnswer{}
	return nil
}

func (previewContract) Role(input *RoleInput, output *RoleAnswer) error {
	*output = RoleAnswer{}
	return nil
}

// readEvents reads Pulumi's event log
func readEvents(data []byte) []events.EngineEvent {
	result := []events.EngineEvent{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for scanner.Scan() {
		var event events.EngineEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err == nil {
			result = append(result, event)
		}
	}
	return result
}

// readPreview reads the functions, roles and outputs from a preview's events
func readPreview(engineEvents []events.EngineEvent) *previewed {
	found := &previewed{functions: map[string]previewedFunction{}}
	roles := map[string]bool{}
	for _, event := range engineEvents {
		if pre := event.ResourcePreEvent; pre != nil && pre.Metadata.New != nil {
			name := resource.URN(pre.Metadata.URN).Name()
			inputs := pre.Metadata.New.Inputs
			switch pre.Metadata.Type {
			case "aws:lambda/function:Function":
				code, _ := inputs["code"].(map[string]interface{})
				packageType, _ := inputs["packageType"].(string)
				imageURI, _ := inputs["imageUri"].(string)
				found.functions[name] = previewedFunction{
					runtime: known(inputs["runtime"]),
					handler: known(inputs["handler"]),
					image:   packageType == "Image" || imageURI != "",
					code:    code,
				}
			case "aws:iam/role:Role":
				roles[name] = true
			}
		}
		if outputs := event.ResOutputsEvent; outputs != nil && outputs.Metadata.Type == "pulumi:pulumi:Stack" && outputs.Metadata.New != nil {
			found.outputs = []string{}
			for _, key := range sortedKeys(outputs.Metadata.New.Outputs) {
				if !strings.HasPrefix(key, "_") {
					found.outputs = append(found.outputs, key)
				}
			}
		}
	}
	found.roles = sortedKeys(roles)
	return found
}

// known is a string a preview knows, or "" for one it doesn't yet
func known(value interface{}) string {
	text, _ := value.(string)
	if text == plugin.UnknownStringValue {
		return ""
	}
	return text
}

// guess is how a function is named in DevFile
type guess struct {
	handler string
	runtime string
	// note says what the handler is guessed from, when it's guessed
	note string
	// unsure says why the function is named in a comment, to fill in
	unsure string
	// cloud says why it can't run on this machine
	cloud string
}

// guessFunction finds a function's source handler from its code, as the
// program deploys it: exactly from a folder of sources, and guessed from a
// build's source map or by the build's name
func guessFunction(root, search string, function previewedFunction) guess {
	switch {
	case function.image:
		return guess{cloud: "a container image"}
	case function.runtime == "":
		return guess{cloud: "its runtime isn't known before it's deployed"}
	case strings.HasPrefix(function.runtime, "provided"):
		return guessNative(root, search, function)
	case !strings.HasPrefix(function.runtime, "nodejs") && !strings.HasPrefix(function.runtime, "python"):
		return guess{cloud: "sst dev doesn't run " + function.runtime}
	case function.handler == "":
		return guess{cloud: "its handler isn't known before it's deployed"}
	}
	extensions, _ := sourceExtensions(function.runtime)
	export := filepath.Ext(function.handler)
	module := strings.TrimSuffix(function.handler, export)
	deployed, from, cloud := deployedFile(root, function.code, module, extensions)
	if cloud != "" {
		return guess{cloud: cloud}
	}
	handler := func(source string) string {
		rel, _ := filepath.Rel(root, source)
		return filepath.ToSlash(strings.TrimSuffix(rel, filepath.Ext(rel))) + export
	}
	shown := shownPath(root, from)
	if deployed != "" && !isBuilt(root, deployed) {
		return guess{handler: handler(deployed)}
	}
	if deployed != "" {
		if sources := mapSources(root, deployed, extensions); len(sources) > 0 {
			if source := pick(sources, nameOf(from, module)); source != "" {
				return guess{handler: handler(source), note: "from the source map in " + shown}
			}
		}
	}
	candidates := findSources(search, nameOf(from, module), extensions)
	switch len(candidates) {
	case 1:
		return guess{handler: handler(candidates[0]), note: "guessed by its name from " + shown}
	case 0:
		return guess{handler: "path/to/source" + export, unsure: "sst dev couldn't find its source from " + shown}
	}
	listed := []string{}
	for _, candidate := range candidates[:min(3, len(candidates))] {
		rel, _ := filepath.Rel(root, candidate)
		listed = append(listed, filepath.ToSlash(rel))
	}
	return guess{handler: handler(candidates[0]), unsure: "sst dev found more than one source like it: " + strings.Join(listed, ", ")}
}

// guessNative finds a Go function's source, a folder of Go named as its build
func guessNative(root, search string, function previewedFunction) guess {
	_, from, cloud := deployedFile(root, function.code, "", nil)
	if cloud != "" {
		return guess{cloud: cloud}
	}
	shown := shownPath(root, from)
	name := nameOf(from, "")
	candidates := []string{}
	walkSources(search, func(path string, entry fs.DirEntry) {
		if entry.IsDir() && entry.Name() == name && hasGo(path) {
			candidates = append(candidates, path)
		}
	})
	if len(candidates) == 1 {
		rel, _ := filepath.Rel(root, candidates[0])
		return guess{handler: filepath.ToSlash(rel), runtime: "go", note: "guessed by its name from " + shown}
	}
	return guess{handler: "path/to/source", runtime: "go", unsure: "on " + function.runtime + ", it needs its source, and runtime: go"}
}

func hasGo(dir string) bool {
	matches, _ := filepath.Glob(filepath.Join(dir, "*.go"))
	return len(matches) > 0
}

// deployedFile is the file of a function's code its handler's module is, if
// it's on this machine, and the folder or file the code is from. cloud says
// why its source can't be on this machine.
func deployedFile(root string, code map[string]interface{}, module string, extensions []string) (deployed, from, cloud string) {
	inFolder := func(folder string) string {
		for _, extension := range extensions {
			if info, err := os.Stat(filepath.Join(folder, module+extension)); err == nil && !info.IsDir() {
				return filepath.Join(folder, module+extension)
			}
		}
		return ""
	}
	if path, ok := code["path"].(string); ok {
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, path)
		}
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			return inFolder(path), path, ""
		}
		// a zip, or a folder that isn't built yet
		return "", path, ""
	}
	if assets, ok := code["assets"].(map[string]interface{}); ok {
		for _, key := range sortedKeys(assets) {
			asset, _ := assets[key].(map[string]interface{})
			path, hasPath := asset["path"].(string)
			if hasPath && !filepath.IsAbs(path) {
				path = filepath.Join(root, path)
			}
			stem := strings.TrimSuffix(key, filepath.Ext(key))
			switch {
			case module == "" && hasPath:
				// a Go function's binary, named by its build's folder
				if filepath.Base(path) == "bootstrap" {
					return "", filepath.Dir(path), ""
				}
				return "", path, ""
			case stem == module && slices.Contains(extensions, filepath.Ext(key)):
				if !hasPath {
					return "", "", "its code is written in the program"
				}
				return path, path, ""
			case hasPath && (key == "." || key == "" || strings.HasPrefix(module, strings.TrimSuffix(key, "/")+"/")):
				// a folder in the archive
				inner := strings.TrimPrefix(module, strings.TrimSuffix(key, "/")+"/")
				if key == "." || key == "" {
					inner = module
				}
				for _, extension := range extensions {
					if file := filepath.Join(path, inner+extension); fileExists(file) {
						return file, path, ""
					}
				}
			}
		}
		if module == "" {
			return "", "", "its code is written in the program"
		}
		return "", "", "its handler's file isn't in its code"
	}
	return "", "", "its code isn't on this machine"
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// buildFolders are folders a build writes to, whose files aren't sources
var buildFolders = []string{"dist", "build", "out", ".build", "target", "cdk.out", ".output", "bundle"}

// isBuilt is whether a function's file is a build's: it's in a build's
// folder, or it has a source map
func isBuilt(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return true
	}
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if slices.Contains(buildFolders, part) {
			return true
		}
	}
	if fileExists(path + ".map") {
		return true
	}
	_, ok := sourceMap(path)
	return ok
}

var sourceMappingURL = regexp.MustCompile(`[#@] sourceMappingURL=(\S+)\s*$`)

// sourceMap is the source map of a built file: the one next to it, or the
// one it names, or the one in it
func sourceMap(path string) ([]byte, bool) {
	if data, err := os.ReadFile(path + ".map"); err == nil {
		return data, true
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, false
	}
	// the reference is on the last line
	size := min(info.Size(), 4*1024*1024)
	tail := make([]byte, size)
	if _, err := file.ReadAt(tail, info.Size()-size); err != nil {
		return nil, false
	}
	match := sourceMappingURL.FindSubmatch(bytes.TrimRight(tail, "\n"))
	if match == nil {
		return nil, false
	}
	reference := string(match[1])
	if data, ok := strings.CutPrefix(reference, "data:application/json;base64,"); ok {
		decoded, err := base64.StdEncoding.DecodeString(data)
		return decoded, err == nil
	}
	if strings.Contains(reference, ":") {
		return nil, false
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(path), reference))
	return data, err == nil
}

// mapSources are the sources in a built file's source map that are the
// program's own, not a package's
func mapSources(root, path string, extensions []string) []string {
	data, ok := sourceMap(path)
	if !ok {
		return nil
	}
	var parsed struct {
		SourceRoot string   `json:"sourceRoot"`
		Sources    []string `json:"sources"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil
	}
	sources := []string{}
	for _, source := range parsed.Sources {
		source = strings.TrimPrefix(source, "file://")
		if !filepath.IsAbs(source) {
			source = filepath.Join(filepath.Dir(path), parsed.SourceRoot, source)
		}
		if strings.Contains(source, string(filepath.Separator)+"node_modules"+string(filepath.Separator)) || !fileExists(source) {
			continue
		}
		if !slices.Contains(extensions, filepath.Ext(source)) || isBuilt(root, source) {
			continue
		}
		sources = append(sources, source)
	}
	return sources
}

// pick is the source the handler's is likely to be: the only one, or the
// only one named name
func pick(sources []string, name string) string {
	if len(sources) == 1 {
		return sources[0]
	}
	named := []string{}
	for _, source := range sources {
		if sourceName(source) == name {
			named = append(named, source)
		}
	}
	if len(named) == 1 {
		return named[0]
	}
	return ""
}

// nameOf is what a function's source is likely named: its module's name, or
// its build's when the module's is one any function's could be, like index
func nameOf(from, module string) string {
	base := filepath.Base(module)
	if module != "" && !slices.Contains([]string{"index", "main", "handler", "lambda", "app", "bootstrap"}, base) {
		return base
	}
	name := filepath.Base(from)
	return strings.TrimSuffix(name, filepath.Ext(name))
}

// sourceName is the name a source file goes by: its own, or its folder's for
// an index
func sourceName(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if name == "index" || name == "main" || name == "__init__" {
		return filepath.Base(filepath.Dir(path))
	}
	return name
}

// findSources are the program's sources named name
func findSources(search, name string, extensions []string) []string {
	found := []string{}
	walkSources(search, func(path string, entry fs.DirEntry) {
		if !entry.IsDir() && slices.Contains(extensions, filepath.Ext(path)) && sourceName(path) == name && !strings.HasSuffix(path, ".d.ts") {
			found = append(found, path)
		}
	})
	slices.Sort(found)
	return found
}

// maxWalked is how many files and folders a search for sources looks at
const maxWalked = 50000

// walkSources visits the program's sources under search: none in packages,
// builds or hidden folders
func walkSources(search string, visit func(path string, entry fs.DirEntry)) {
	walked := 0
	filepath.WalkDir(search, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		walked++
		if walked > maxWalked {
			return filepath.SkipAll
		}
		if entry.IsDir() && path != search {
			name := entry.Name()
			if name == "node_modules" || strings.HasPrefix(name, ".") || slices.Contains(buildFolders, name) || name == "__pycache__" || name == "venv" {
				return filepath.SkipDir
			}
		}
		visit(path, entry)
		return nil
	})
}

// shownPath is a path as the file shows it, from the project's folder
func shownPath(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	rel = filepath.ToSlash(rel)
	if !strings.HasPrefix(rel, "..") {
		rel = "./" + rel
	}
	return rel
}

// devFileText is the DevFile written for what a preview found
func devFileText(root, stage string, found *previewed) *Written {
	written := &Written{Guessed: []string{}}
	search := watchRoot(root)
	var functions, cloud strings.Builder
	for _, name := range sortedKeys(found.functions) {
		if strings.ContainsAny(name, "*?") {
			fmt.Fprintf(&cloud, "# %s: its name has a * or ?, which %s reads as a pattern\n", name, DevFile)
			written.Cloud++
			continue
		}
		g := guessFunction(root, search, found.functions[name])
		if g.cloud != "" {
			fmt.Fprintf(&cloud, "# %s: %s\n", name, g.cloud)
			written.Cloud++
			continue
		}
		note := ""
		switch {
		case g.unsure != "":
			note = " # " + g.unsure
			written.Cloud++
		case g.note != "":
			note = " # " + g.note + ": check it"
			written.Here++
			written.Guessed = append(written.Guessed, name)
		default:
			written.Here++
		}
		lines := []string{yamlScalar(name) + ": " + yamlScalar(g.handler) + note}
		if g.runtime != "" {
			lines = []string{yamlScalar(name) + ":" + note, "  handler: " + yamlScalar(g.handler), "  runtime: " + g.runtime}
		}
		for _, line := range lines {
			if g.unsure != "" {
				line = "# " + line
			}
			functions.WriteString("  " + line + "\n")
		}
	}

	var text strings.Builder
	fmt.Fprintf(&text, "# yaml-language-server: $schema=%s\n", schemaPath(root))
	fmt.Fprintf(&text, "#\n# What sst dev runs of the program. It was written from a preview of the\n# %q stack: a function's handler is its source, from this folder, so check\n# the ones it guessed.\n\n", stage)
	if len(found.functions) == 0 {
		text.WriteString("# The program made no function.\n")
	}
	text.WriteString("functions:\n")
	text.WriteString(functions.String())
	if cloud.Len() > 0 {
		text.WriteString("\n# What sst dev can't run on this machine, which stays in the cloud:\n")
		text.WriteString(cloud.String())
	}
	example := "API_URL: ${apiUrl}"
	if len(found.outputs) > 0 {
		example = envName(found.outputs[0]) + ": ${" + found.outputs[0] + "}"
	}
	fmt.Fprintf(&text, "\n# Dev commands run beside sst dev, each in a pane of its own, like:\n#\n# commands:\n#   Web:\n#     command: npm run dev\n#     directory: web\n#     environment:\n#       %s\n", example)
	if len(found.outputs) > 0 {
		fmt.Fprintf(&text, "#\n# The stack's outputs, for ${name}: %s\n", strings.Join(found.outputs, ", "))
	}
	if len(found.roles) > 0 {
		fmt.Fprintf(&text, "# Its roles, for a command's role: %s\n", strings.Join(found.roles, ", "))
	}
	written.Text = text.String()
	return written
}

// watchRoot is where sources are searched for: the program's repository, or
// the project's folder outside one
func watchRoot(root string) string {
	return (&Program{root: root}).PathWatch()
}

// schemaPath is where the schema the sst package ships is, from the project's
// folder
func schemaPath(root string) string {
	const schema = "node_modules/sst/schema/sst.dev.json"
	for dir := root; ; dir = filepath.Dir(dir) {
		if path := filepath.Join(dir, schema); fileExists(path) {
			return shownPath(root, path)
		}
		if filepath.Dir(dir) == dir {
			return "./" + schema
		}
	}
}

var plainScalar = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$`)

// yamlScalar is a name or a path as YAML takes it
func yamlScalar(value string) string {
	if plainScalar.MatchString(value) && !slices.Contains([]string{"true", "false", "null", "yes", "no", "on", "off"}, strings.ToLower(value)) {
		return value
	}
	data, _ := json.Marshal(value)
	return string(data)
}

// envName is an output's name as an environment variable's, like API_URL for
// apiUrl
func envName(output string) string {
	var name strings.Builder
	for i, r := range output {
		if i > 0 && r >= 'A' && r <= 'Z' {
			name.WriteByte('_')
		}
		if r == '-' || r == '.' {
			r = '_'
		}
		name.WriteRune(r)
	}
	return strings.ToUpper(name.String())
}
