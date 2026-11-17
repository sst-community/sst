package eject

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// The TypeScript the module is written in: values as the state has them,
// references to other resources' outputs, and secrets read from the config.

type expr interface {
	// ts writes the expression, its lines after the first indented by indent
	ts(indent string) string
}

// literal is a string, number, boolean or null
type literal struct{ value any }

// object is an object literal, with its keys in order
type object struct {
	keys   []string
	values map[string]expr
}

type array []expr

// raw is TypeScript written as it is, like a reference to an output
type raw string

// interpolated is an output followed by text, like `${bucket.arn}/*`
type interpolated struct {
	ref    string
	suffix string
}

// jsonText is a string that's JSON, written as the value it's made from
type jsonText struct {
	value  expr
	indent string
	// refs is whether it has a reference in it, so it's an Output
	refs bool
}

func newObject() *object {
	return &object{values: map[string]expr{}}
}

func (o *object) set(key string, value expr) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// sortedObject is an object with its keys in order, as Pulumi writes a
// state's
func sortedObject(values map[string]expr) *object {
	o := newObject()
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		o.set(key, values[key])
	}
	return o
}

func (l literal) ts(indent string) string {
	switch value := l.value.(type) {
	case nil:
		return "null"
	case string:
		return tsString(value, indent)
	case json.Number:
		return value.String()
	case bool:
		if value {
			return "true"
		}
		return "false"
	}
	panic(fmt.Sprintf("eject: a literal of type %T", l.value))
}

// width is how long a line of the module gets, where it can be helped
const width = 80

// An object that fits goes on one line
func (o *object) ts(indent string) string {
	if len(o.keys) == 0 {
		return "{}"
	}
	inner := indent + "  "
	entries := make([]string, len(o.keys))
	short := true
	for i, key := range o.keys {
		entries[i] = tsKey(key) + ": " + o.values[key].ts(inner)
		if strings.Contains(entries[i], "\n") {
			short = false
		}
	}
	if line := "{ " + strings.Join(entries, ", ") + " }"; short && len(indent)+len(line) <= width-10 {
		return line
	}
	var b strings.Builder
	b.WriteString("{\n")
	for _, entry := range entries {
		b.WriteString(inner + entry + ",\n")
	}
	b.WriteString(indent + "}")
	return b.String()
}

// An array that fits goes on one line
func (a array) ts(indent string) string {
	if len(a) == 0 {
		return "[]"
	}
	parts := make([]string, len(a))
	short := true
	for i, item := range a {
		parts[i] = item.ts(indent + "  ")
		if strings.Contains(parts[i], "\n") {
			short = false
		}
	}
	if line := "[" + strings.Join(parts, ", ") + "]"; short && len(indent)+len(line) <= width-10 {
		return line
	}
	inner := indent + "  "
	var b strings.Builder
	b.WriteString("[\n")
	for _, part := range parts {
		b.WriteString(inner + part + ",\n")
	}
	b.WriteString(indent + "]")
	return b.String()
}

func (r raw) ts(string) string { return string(r) }

func (i interpolated) ts(string) string {
	return "pulumi.interpolate`${" + i.ref + "}" + templateText(i.suffix) + "`"
}

func (j jsonText) ts(indent string) string {
	space := ""
	switch j.indent {
	case "":
	case "\t":
		space = `, "\t"`
	default:
		space = fmt.Sprintf(", %d", len(j.indent))
	}
	if j.refs {
		if space != "" {
			space = ", undefined" + space
		}
		return "pulumi.jsonStringify(" + j.value.ts(indent) + space + ")"
	}
	if space != "" {
		space = ", null" + space
	}
	return "JSON.stringify(" + j.value.ts(indent) + space + ")"
}

var identifier = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

func tsKey(key string) string {
	if identifier.MatchString(key) {
		return key
	}
	return quote(key)
}

// tsString is a string as TypeScript: a template literal when it has more
// than one line, like a function's code, and quoted otherwise
func tsString(value, indent string) string {
	if strings.Count(value, "\n") >= 2 && !strings.ContainsRune(value, '\r') {
		return "`" + templateText(value) + "`"
	}
	return quote(value)
}

// quote is a string in double quotes, as JSON writes it, without escaping
// the characters HTML would need escaped
func quote(value string) string {
	var b strings.Builder
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(b.String(), "\n")
}

// templateText is text in a template literal
func templateText(value string) string {
	var b strings.Builder
	for i, r := range value {
		switch {
		case r == '\\':
			b.WriteString(`\\`)
		case r == '`':
			b.WriteString("\\`")
		case r == '$' && strings.HasPrefix(value[i:], "${"):
			b.WriteString(`\$`)
		case r == '\n' || r == '\t':
			b.WriteRune(r)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

var reserved = map[string]bool{}

func init() {
	for _, word := range strings.Fields(`break case catch class const continue debugger default delete do else enum
		export extends false finally for function if import in instanceof new null return super switch this throw
		true try typeof var void while with as implements interface let package private protected public static
		yield await async of any boolean number string symbol type from get set module namespace declare constructor
		undefined arguments eval require exports`) {
		reserved[word] = true
	}
}

// comment is text as a comment, its lines at most width long
func comment(text, indent string) string {
	var b strings.Builder
	line := ""
	for _, word := range strings.Fields(text) {
		if line != "" && len(indent)+3+len(line)+1+len(word) > width {
			b.WriteString(indent + "// " + line + "\n")
			line = ""
		}
		if line != "" {
			line += " "
		}
		line += word
	}
	if line != "" {
		b.WriteString(indent + "// " + line + "\n")
	}
	return b.String()
}

// varName is a TypeScript name for a resource's name, like apiFunction for
// ApiFunction
func varName(name string) string {
	var words []string
	var word strings.Builder
	for _, r := range name {
		if r == '_' || r == '$' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' {
			word.WriteRune(r)
			continue
		}
		if word.Len() > 0 {
			words = append(words, word.String())
			word.Reset()
		}
	}
	if word.Len() > 0 {
		words = append(words, word.String())
	}
	if len(words) == 0 {
		return "resource"
	}
	var b strings.Builder
	for i, w := range words {
		if i == 0 {
			b.WriteString(strings.ToLower(w[:1]) + w[1:])
		} else {
			b.WriteString(strings.ToUpper(w[:1]) + w[1:])
		}
	}
	result := b.String()
	if result[0] >= '0' && result[0] <= '9' {
		result = "_" + result
	}
	if reserved[result] {
		result += "_"
	}
	return result
}

// stackSecret is a secret input in one stack's state, which the merge of
// the stacks puts in each one's config
type stackSecret struct {
	path  string
	value any
}

func (s stackSecret) ts(string) string {
	panic("eject: a secret that wasn't put in the config: " + s.path)
}

// configRead is a value read from the stack's config, under ConfigNamespace,
// like config.require("ApiFunction.name")
type configRead struct {
	key    string
	method string
}

func (c configRead) ts(string) string {
	return "config." + c.method + "(" + quote(c.key) + ")"
}

// byStack is a value each stack has its own of, which aren't all plain
// values, so they're written in the code: `byStack({ dev: () => ... })`
type byStack struct {
	stacks []string
	values []expr
}

func (b byStack) ts(indent string) string {
	inner := indent + "  "
	var out strings.Builder
	out.WriteString("byStack({\n")
	for i, stack := range b.stacks {
		out.WriteString(inner + tsKey(stack) + ": () => " + b.values[i].ts(inner) + ",\n")
	}
	out.WriteString(indent + "})")
	return out.String()
}
