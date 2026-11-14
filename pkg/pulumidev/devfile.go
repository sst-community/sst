package pulumidev

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/project"
	"gopkg.in/yaml.v3"
)

// DevFile is the file next to Pulumi.yaml that says what sst pulumi dev runs of the
// program: the functions to run on this machine, and the dev commands.
const DevFile = "sst.dev.yaml"

// devFile is what DevFile says
type devFile struct {
	// Functions run on this machine in sst pulumi dev, by their name in the program
	// or a pattern of names
	Functions devFunctions `yaml:"functions"`
	// Commands run beside sst pulumi dev, each in a pane of its own, by name
	Commands map[string]devCommand `yaml:"commands"`
	// dir is the folder the file is in, which a command's directory is from
	dir string
}

// fileFields are what DevFile has
var fileFields = []string{"functions", "commands"}

func (f *devFile) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("line %d: %s is a mapping of %s", node.Line, DevFile, strings.Join(fileFields, " and "))
	}
	if err := knownKeys(node, fileFields...); err != nil {
		return err
	}
	type plain devFile
	return node.Decode((*plain)(f))
}

// devFunction is a function sst pulumi dev runs on this machine: its source
// handler, from the project's folder, alone or with its settings
type devFunction struct {
	Handler string
	// Runtime builds and runs it, when the function's own can't, as
	// provided.al2023's: go
	Runtime string
	// Streaming is whether it streams its response
	Streaming bool
}

// functionFields are what a function given with its settings has
var functionFields = []string{"handler", "runtime", "streaming"}

func (f *devFunction) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind == yaml.ScalarNode {
		f.Handler = node.Value
		return nil
	}
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("line %d: expected a handler, or a mapping of %s", node.Line, strings.Join(functionFields, ", "))
	}
	if err := knownKeys(node, functionFields...); err != nil {
		return err
	}
	var settings struct {
		Handler   string `yaml:"handler"`
		Runtime   string `yaml:"runtime"`
		Streaming bool   `yaml:"streaming"`
	}
	if err := node.Decode(&settings); err != nil {
		return err
	}
	*f = devFunction(settings)
	return nil
}

// devFunctions are the file's functions: by their name in the program, and
// by patterns of names, in the file's order. A pattern's * is any text, and
// its ? any one character.
type devFunctions struct {
	byName   map[string]devFunction
	patterns []devPattern
}

type devPattern struct {
	pattern  string
	match    *regexp.Regexp
	function devFunction
}

func (f *devFunctions) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("line %d: functions is a mapping of names to handlers", node.Line)
	}
	f.byName = map[string]devFunction{}
	seen := map[string]bool{}
	for i := 0; i < len(node.Content); i += 2 {
		name := node.Content[i].Value
		if seen[name] {
			return fmt.Errorf("line %d: the %q function is named twice", node.Content[i].Line, name)
		}
		seen[name] = true
		var function devFunction
		if err := node.Content[i+1].Decode(&function); err != nil {
			return err
		}
		if !strings.ContainsAny(name, "*?") {
			f.byName[name] = function
			continue
		}
		expression := regexp.QuoteMeta(name)
		expression = strings.ReplaceAll(expression, `\*`, ".*")
		expression = strings.ReplaceAll(expression, `\?`, ".")
		f.patterns = append(f.patterns, devPattern{pattern: name, match: regexp.MustCompile("^" + expression + "$"), function: function})
	}
	return nil
}

// find is the function the file names, by the function's name in the program,
// or the first pattern that matches it, with {name} in its handler as the
// name. pattern is the pattern that matched, or "" for the name itself.
func (f devFunctions) find(name string) (function devFunction, pattern string, ok bool) {
	if function, ok := f.byName[name]; ok {
		function.Handler = strings.ReplaceAll(function.Handler, "{name}", name)
		return function, "", true
	}
	for _, candidate := range f.patterns {
		if candidate.match.MatchString(name) {
			function := candidate.function
			function.Handler = strings.ReplaceAll(function.Handler, "{name}", name)
			return function, candidate.pattern, true
		}
	}
	return devFunction{}, "", false
}

// all are the file's functions and patterns, as they're written
func (f devFunctions) all() map[string]devFunction {
	result := map[string]devFunction{}
	for name, function := range f.byName {
		result[name] = function
	}
	for _, pattern := range f.patterns {
		result[pattern.pattern] = pattern.function
	}
	return result
}

// devCommand is a command sst pulumi dev runs in a pane of its own
type devCommand struct {
	Command string `yaml:"command"`
	// Directory it runs in, from the file's folder
	Directory string `yaml:"directory"`
	// Autostart is whether it starts with sst pulumi dev; it does when it's unset
	Autostart *bool  `yaml:"autostart"`
	Title     string `yaml:"title"`
	// Environment it runs with, where ${name} is the stack's output of that
	// name
	Environment map[string]string `yaml:"environment"`
	// Role it runs as: a role of the program, by name, or an ARN
	Role string `yaml:"role"`
}

// commandFields are what a dev command has
var commandFields = []string{"command", "directory", "autostart", "title", "environment", "role"}

func (c *devCommand) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("line %d: a dev command is a mapping of %s", node.Line, strings.Join(commandFields, ", "))
	}
	if err := knownKeys(node, commandFields...); err != nil {
		return err
	}
	type plain devCommand
	return node.Decode((*plain)(c))
}

// roleName is the name in the program of the role the command runs as, or ""
// when it's given by its ARN or has none
func (c devCommand) roleName() string {
	if strings.HasPrefix(c.Role, "arn:") {
		return ""
	}
	return c.Role
}

// knownKeys refuses a mapping with a key that isn't one of keys, and says
// which it likely meant
func knownKeys(node *yaml.Node, keys ...string) error {
	for i := 0; i < len(node.Content); i += 2 {
		key := node.Content[i]
		if slices.Contains(keys, key.Value) {
			continue
		}
		if found := closest(key.Value, keys); found != "" {
			return fmt.Errorf("line %d: field %s not found: did you mean %s?", key.Line, key.Value, found)
		}
		return fmt.Errorf("line %d: field %s not found, expected %s", key.Line, key.Value, strings.Join(keys, ", "))
	}
	return nil
}

// devFileExample is what the error for a missing DevFile shows
const devFileExample = `functions:
  Api: functions/api.handler
commands:
  Web:
    command: npm run dev
    directory: web
    environment:
      API_URL: ${apiUrl}`

// readDevFileFor reads the project's DevFile, for a program that imports
// SST's components or doesn't. SST's components say what runs in sst pulumi dev
// themselves, so such a program needs no DevFile, and without one has none.
func readDevFileFor(root string, components bool) (*devFile, error) {
	dev, err := readDevFile(root)
	if components && errors.Is(err, ErrNoDevFile) {
		return &devFile{dir: root}, nil
	}
	return dev, err
}

// readDevFile reads the project's DevFile
func readDevFile(root string) (*devFile, error) {
	path := filepath.Join(root, DevFile)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, util.NewReadableError(ErrNoDevFile, fmt.Sprintf("sst pulumi dev runs what %s next to Pulumi.yaml names, and there's none. Add one, like:\n\n%s", DevFile, devFileExample))
	}
	if err != nil {
		return nil, err
	}
	file, err := parseDevFile(data)
	if err != nil {
		return nil, util.NewReadableError(err, DevFile+": "+err.Error())
	}
	file.dir = root
	if err := file.checkSources(root); err != nil {
		return nil, util.NewReadableError(err, DevFile+": "+err.Error())
	}
	return file, nil
}

// checkSources refuses a function named in the file whose handler has no
// source, before a deploy: one a pattern names is checked as the program
// makes it, as a pattern can name what sst pulumi dev can't run
func (f *devFile) checkSources(root string) error {
	for _, name := range sortedKeys(f.Functions.byName) {
		function, _, _ := f.Functions.find(name)
		if !hasSource(root, function.Handler, function.Runtime) {
			return noSource(root, name, function.Handler, function.Runtime)
		}
	}
	return nil
}

// parseDevFile reads what DevFile says, and refuses a field it doesn't know,
// so a misspelt one isn't left out without a word
func parseDevFile(data []byte) (*devFile, error) {
	file := &devFile{}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(file); err != nil && !errors.Is(err, io.EOF) {
		return nil, errors.New(yamlError(err))
	}
	return file, file.check()
}

// yamlError is what yaml said, in words for the file rather than the CLI's
// types
func yamlError(err error) string {
	message := strings.TrimPrefix(err.Error(), "yaml: ")
	message = strings.ReplaceAll(message, "unmarshal errors:\n  ", "")
	message = yamlTypes.ReplaceAllString(message, "")
	return yamlKinds.ReplaceAllStringFunc(message, func(found string) string {
		kind := yamlKinds.FindStringSubmatch(found)[1]
		names := map[string]string{"seq": "a list", "map": "a mapping", "str": "a string", "int": "a number", "float": "a number", "bool": "true or false", "null": "nothing"}
		name, ok := names[kind]
		if !ok {
			name = kind
		}
		return name + " isn't expected here"
	})
}

var yamlTypes = regexp.MustCompile(` in type [\w.*\[\]]+`)
var yamlKinds = regexp.MustCompile("cannot unmarshal !!(\\w+)( `[^`]*`)? into \\S+")

// check refuses what sst pulumi dev couldn't run
func (f *devFile) check() error {
	ids := map[string]string{}
	all := f.Functions.all()
	for _, name := range sortedKeys(all) {
		handler := all[name].Handler
		if handler == "" {
			return fmt.Errorf("the %q function needs its handler", name)
		}
		if rest := strings.ReplaceAll(handler, "{name}", ""); strings.ContainsAny(rest, "{}") {
			return fmt.Errorf("the %q function's handler %q has a { } that isn't {name}", name, handler)
		}
		// Rust's handlers aren't paths as the others' are, and running one
		// from a Pulumi program hasn't been tried
		if runtime := all[name].Runtime; strings.HasPrefix(runtime, "rust") {
			return fmt.Errorf("the %q function's runtime is %s, which sst pulumi dev doesn't run for a Pulumi program yet", name, runtime)
		}
		if _, ok := f.Functions.byName[name]; !ok {
			continue
		}
		// the stubs and sst pulumi dev tell functions apart by their ids
		id := liveID(name)
		if other, ok := ids[id]; ok {
			return fmt.Errorf("the %q and %q functions would share the id %q in sst pulumi dev: rename one", other, name, id)
		}
		ids[id] = name
	}
	for _, name := range sortedKeys(f.Commands) {
		if strings.TrimSpace(f.Commands[name].Command) == "" {
			return fmt.Errorf("the %q dev command needs its command", name)
		}
		if directory := f.Commands[name].Directory; filepath.IsAbs(directory) {
			return fmt.Errorf("the %q dev command's directory is from the folder of Pulumi.yaml, and %s is a full path", name, directory)
		}
	}
	return nil
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// liveID is the id sst pulumi dev knows a function by, from its name in the program:
// it names the function's folder of built code too, so it keeps letters,
// numbers, hyphens and underscores, and has a hyphen for anything else.
func liveID(name string) string {
	return strings.Map(func(r rune) rune {
		if r == '-' || r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return '-'
	}, name)
}

// outputReference is ${name} in a dev command's environment
var outputReference = regexp.MustCompile(`\$\{([^}]*)\}`)

// fillOutputs puts the stack's output in place of each ${name} in value. A
// value that isn't a string is written as JSON. An output that is or holds a
// secret is read in the clear with reveal, which is the only way a secret is.
func fillOutputs(value string, outputs map[string]interface{}, reveal func(name string) (interface{}, error)) (string, error) {
	var missing []string
	var failed error
	filled := outputReference.ReplaceAllStringFunc(value, func(reference string) string {
		name := strings.TrimSpace(outputReference.FindStringSubmatch(reference)[1])
		output, ok := outputs[name]
		if !ok {
			missing = append(missing, name)
			return reference
		}
		if hasSecret(output) {
			revealed, err := reveal(name)
			if err != nil {
				if failed == nil {
					failed = fmt.Errorf("reading the secret output %q: %w", name, err)
				}
				return reference
			}
			output = revealed
		}
		if text, ok := output.(string); ok {
			return text
		}
		data, _ := json.Marshal(output)
		return string(data)
	})
	if len(missing) > 0 {
		names := []string{}
		for name := range outputs {
			if !strings.HasPrefix(name, "_") {
				names = append(names, name)
			}
		}
		if suggestion := didYouMean(missing[0], names); suggestion != "" {
			return "", fmt.Errorf("the stack has no output %q: %s", missing[0], suggestion)
		}
		return "", fmt.Errorf("the stack has no output %q", missing[0])
	}
	if failed != nil {
		return "", failed
	}
	return filled, nil
}

// directory is a command's directory as sst pulumi dev takes it, from the folder it
// runs in, which can be under the project's
func (f *devFile) directory(directory string) string {
	cwd, err := os.Getwd()
	if f.dir == "" || err != nil {
		return directory
	}
	rel, err := filepath.Rel(cwd, filepath.Join(f.dir, directory))
	if err != nil {
		return directory
	}
	return rel
}

// devs are the dev commands, as sst pulumi dev runs them: their environment with the
// stack's outputs, and their role's ARN, from the roles in the state by name.
// A command that can't be run is left out, with an error that says why.
func (f *devFile) devs(outputs map[string]interface{}, roles map[string][]string, reveal func(name string) (interface{}, error)) (project.Devs, []project.Error) {
	devs := project.Devs{}
	problems := []project.Error{}
	// each secret output is read once, however many commands take it
	revealed := map[string]interface{}{}
	revealOnce := func(name string) (interface{}, error) {
		if value, ok := revealed[name]; ok {
			return value, nil
		}
		if reveal == nil {
			return nil, fmt.Errorf("secrets aren't read here")
		}
		value, err := reveal(name)
		if err == nil {
			revealed[name] = value
		}
		return value, err
	}
	for _, name := range sortedKeys(f.Commands) {
		command := f.Commands[name]
		dev := project.Dev{
			Name:        name,
			Command:     command.Command,
			Directory:   f.directory(command.Directory),
			Autostart:   command.Autostart == nil || *command.Autostart,
			Title:       command.Title,
			Links:       []string{},
			Environment: map[string]string{},
		}
		err := func() error {
			for _, key := range sortedKeys(command.Environment) {
				value, err := fillOutputs(command.Environment[key], outputs, revealOnce)
				if err != nil {
					return fmt.Errorf("its %s: %w", key, err)
				}
				dev.Environment[key] = value
			}
			arn := command.Role
			if role := command.roleName(); role != "" {
				switch found := roles[role]; len(found) {
				case 0:
					if suggestion := didYouMean(role, sortedKeys(roles)); suggestion != "" {
						return fmt.Errorf("it runs as %q, and the stack has no role of that name: %s", role, suggestion)
					}
					return fmt.Errorf("it runs as %q, and the stack has no role of that name", role)
				case 1:
					arn = found[0]
				default:
					return fmt.Errorf("it runs as %q, and the stack has %d roles of that name: give its ARN", role, len(found))
				}
			}
			if arn != "" {
				// its role's credentials, and none of the developer's
				dev.Aws = &project.DevAws{Role: arn, Only: true}
			}
			return nil
		}()
		if err != nil {
			problems = append(problems, project.Error{Message: sentence(fmt.Sprintf("The %q dev command in %s can't run: %v", name, DevFile, err))})
			continue
		}
		devs[name] = dev
	}
	return devs, problems
}

// sentence ends a message with a full stop, unless it asks a question
func sentence(message string) string {
	if strings.HasSuffix(message, "?") || strings.HasSuffix(message, ".") {
		return message
	}
	return message + "."
}
