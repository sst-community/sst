package console

import (
	"fmt"
	"slices"
	"strings"
)

// All is what --console means without a list: every module.
const All = "all"

// Parse reads which modules are on from --console's value, or SST_CONSOLE's
// when the flag isn't given. Nothing, off, false or 0 is none, and nil means
// the console doesn't start. all, true or 1 is every module. Otherwise it's a
// list of names, with the modules each needs, in the order of available.
func Parse(flag string, env string, available []Module) ([]string, error) {
	value := strings.TrimSpace(flag)
	if value == "" {
		value = strings.TrimSpace(env)
	}
	switch strings.ToLower(value) {
	case "", "off", "false", "0":
		return nil, nil
	case All, "true", "1":
		names := make([]string, 0, len(available))
		for _, m := range available {
			names = append(names, m.Name())
		}
		return names, nil
	}
	byName := map[string]Module{}
	known := []string{}
	for _, m := range available {
		byName[m.Name()] = m
		known = append(known, m.Name())
	}
	want := map[string]bool{}
	var add func(name string, from string) error
	add = func(name string, from string) error {
		m, ok := byName[name]
		if !ok {
			if from != "" {
				return fmt.Errorf("console module %q needs %q, which isn't there", from, name)
			}
			return fmt.Errorf("there's no console module %q: the modules are %s", name, strings.Join(known, ", "))
		}
		if want[name] {
			return nil
		}
		want[name] = true
		if r, ok := m.(Requirer); ok {
			for _, dep := range r.Requires() {
				if err := add(dep, name); err != nil {
					return err
				}
			}
		}
		return nil
	}
	for _, part := range strings.Split(value, ",") {
		name := strings.ToLower(strings.TrimSpace(part))
		if name == "" {
			continue
		}
		if err := add(name, ""); err != nil {
			return nil, err
		}
	}
	names := []string{}
	for _, name := range known {
		if want[name] {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return nil, nil
	}
	return slices.Clip(names), nil
}

// Misplaced is an error when --console was given bare and followed by a list
// of modules, as in `sst dev --console logs`: the value has to be given with
// =, or it's taken for the command to run.
func Misplaced(flag string, args []string, available []Module) error {
	if flag != All || len(args) == 0 {
		return nil
	}
	names, err := Parse(args[0], "", available)
	if err != nil || names == nil || args[0] == All || strings.EqualFold(args[0], "true") || args[0] == "1" {
		return nil
	}
	return fmt.Errorf("give --console its modules with =, as in --console=%s: with a space, %q is taken for the command to run", args[0], args[0])
}
