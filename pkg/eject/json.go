package eject

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// A string that's JSON, like a policy, is written as the value it's made
// from when JSON.stringify gives the same string back: in the same order,
// with the same spacing.

// orderedObject is a JSON object with its keys in the order they're written
type orderedObject struct {
	keys   []string
	values map[string]any
}

// parseJSONText reads a string that's a JSON object or array, keeping the
// order of its keys and its numbers as they're written
func parseJSONText(text string) (any, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || trimmed[0] != '{' && trimmed[0] != '[' {
		return nil, false
	}
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	value, err := readOrdered(decoder)
	if err != nil {
		return nil, false
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, false
	}
	return value, true
}

func readOrdered(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return token, nil
	}
	switch delim {
	case '{':
		object := &orderedObject{values: map[string]any{}}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			if !ok {
				return nil, fmt.Errorf("a key that isn't a string")
			}
			value, err := readOrdered(decoder)
			if err != nil {
				return nil, err
			}
			if _, seen := object.values[name]; seen {
				return nil, fmt.Errorf("the key %q twice", name)
			}
			object.keys = append(object.keys, name)
			object.values[name] = value
		}
		_, err := decoder.Token()
		return object, err
	case '[':
		list := []any{}
		for decoder.More() {
			value, err := readOrdered(decoder)
			if err != nil {
				return nil, err
			}
			list = append(list, value)
		}
		_, err := decoder.Token()
		return list, err
	}
	return nil, fmt.Errorf("unexpected %v", delim)
}

// jsonIndent is how the text was written by JSON.stringify: "" with no
// spacing, or the indent of each level. ok is false when JSON.stringify
// wouldn't write it so, or when a JavaScript object wouldn't keep it as it
// is, as with a key that's a number, which JavaScript puts first.
func jsonIndent(text string, value any) (string, bool) {
	if !keepsOrder(value) {
		return "", false
	}
	for _, indent := range []string{"", "  ", "    ", "\t"} {
		written, ok := stringify(value, indent, "")
		if ok && written == text {
			return indent, true
		}
	}
	return "", false
}

var arrayIndex = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

func keepsOrder(value any) bool {
	switch value := value.(type) {
	case *orderedObject:
		for _, key := range value.keys {
			if arrayIndex.MatchString(key) || key == "__proto__" || !keepsOrder(value.values[key]) {
				return false
			}
		}
	case []any:
		for _, item := range value {
			if !keepsOrder(item) {
				return false
			}
		}
	}
	return true
}

// integer is a number JavaScript writes as it is here
var integer = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,14})$`)

// stringify is JSON.stringify(value, null, indent)
func stringify(value any, indent, current string) (string, bool) {
	switch value := value.(type) {
	case nil:
		return "null", true
	case bool:
		if value {
			return "true", true
		}
		return "false", true
	case json.Number:
		return value.String(), integer.MatchString(value.String())
	case string:
		return jsQuote(value), true
	case []any:
		if len(value) == 0 {
			return "[]", true
		}
		inner := current + indent
		parts := make([]string, len(value))
		for i, item := range value {
			part, ok := stringify(item, indent, inner)
			if !ok {
				return "", false
			}
			parts[i] = part
		}
		if indent == "" {
			return "[" + strings.Join(parts, ",") + "]", true
		}
		return "[\n" + inner + strings.Join(parts, ",\n"+inner) + "\n" + current + "]", true
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
			part, ok := stringify(value.values[key], indent, inner)
			if !ok {
				return "", false
			}
			parts[i] = jsQuote(key) + separator + part
		}
		if indent == "" {
			return "{" + strings.Join(parts, ",") + "}", true
		}
		return "{\n" + inner + strings.Join(parts, ",\n"+inner) + "\n" + current + "}", true
	}
	return "", false
}

// jsQuote is a string as JSON.stringify writes it
func jsQuote(value string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
