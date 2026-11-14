package pulumidev

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The schema editors check sst.dev.yaml with, which the sst package ships,
// has the fields the CLI reads, and no other
func TestSchemaMatchesDevFile(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "sdk", "js", "schema", "sst.dev.json"))
	if err != nil {
		t.Fatal(err)
	}
	type object struct {
		Properties           map[string]json.RawMessage `json:"properties"`
		Required             []string                   `json:"required"`
		AdditionalProperties json.RawMessage            `json:"additionalProperties"`
		OneOf                []json.RawMessage          `json:"oneOf"`
	}
	read := func(raw json.RawMessage) object {
		t.Helper()
		var parsed object
		if err := json.Unmarshal(raw, &parsed); err != nil {
			t.Fatal(err)
		}
		return parsed
	}
	keys := func(o object) []string {
		names := sortedKeys(o.Properties)
		return names
	}
	tags := func(value interface{}) []string {
		var names []string
		kind := reflect.TypeOf(value)
		for i := 0; i < kind.NumField(); i++ {
			if tag, _, _ := strings.Cut(kind.Field(i).Tag.Get("yaml"), ","); tag != "" {
				names = append(names, tag)
			}
		}
		slices.Sort(names)
		return names
	}

	// the fields the CLI takes, which it checks itself, are the ones it reads
	sorted := func(fields []string) []string {
		return slices.Sorted(slices.Values(fields))
	}
	if !slices.Equal(sorted(fileFields), tags(devFile{})) || !slices.Equal(sorted(commandFields), tags(devCommand{})) {
		t.Fatalf("the CLI takes %v and %v, and reads %v and %v", fileFields, commandFields, tags(devFile{}), tags(devCommand{}))
	}

	root := read(data)
	if got, want := keys(root), tags(devFile{}); !slices.Equal(got, want) {
		t.Fatalf("top level: the schema has %v, the CLI reads %v", got, want)
	}
	command := read(read(root.Properties["commands"]).AdditionalProperties)
	if got, want := keys(command), tags(devCommand{}); !slices.Equal(got, want) {
		t.Fatalf("a command: the schema has %v, the CLI reads %v", got, want)
	}
	if !slices.Equal(command.Required, []string{"command"}) {
		t.Fatalf("a command needs %v", command.Required)
	}
	forms := read(read(root.Properties["functions"]).AdditionalProperties).OneOf
	if len(forms) != 2 {
		t.Fatalf("a function has %d forms", len(forms))
	}
	function := read(forms[1])
	want := slices.Sorted(slices.Values(functionFields))
	if got := keys(function); !slices.Equal(got, want) {
		t.Fatalf("a function: the schema has %v, the CLI reads %v", got, want)
	}
	if !slices.Equal(function.Required, []string{"handler"}) {
		t.Fatalf("a function needs %v", function.Required)
	}
}
