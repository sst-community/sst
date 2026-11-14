package pulumidev

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// closest is the candidate a misspelt name most likely meant, or "" when none
// is close: one a few edits away, case aside, or else the only one that holds
// the name or that the name holds, as Api and ApiHandler
func closest(name string, candidates []string) string {
	sorted := slices.Clone(candidates)
	slices.Sort(sorted)
	lower := strings.ToLower(name)
	limit := max(1, min(3, len(name)/3))
	best, bestDistance := "", limit+1
	for _, candidate := range sorted {
		if candidate == name {
			continue
		}
		if distance := editDistance(lower, strings.ToLower(candidate)); distance < bestDistance {
			best, bestDistance = candidate, distance
		}
	}
	if best != "" {
		return best
	}
	holding := ""
	for _, candidate := range sorted {
		other := strings.ToLower(candidate)
		if candidate == name || lower == "" || !(strings.Contains(other, lower) || strings.Contains(lower, other)) {
			continue
		}
		if holding != "" {
			return ""
		}
		holding = candidate
	}
	return holding
}

// didYouMean asks about the candidate a misspelt name most likely meant, as
// the end of a sentence, or is "" when none is close
func didYouMean(name string, candidates []string) string {
	if found := closest(name, candidates); found != "" {
		return fmt.Sprintf("did you mean %q?", found)
	}
	return ""
}

// editDistance is how many letters have to be added, taken out or changed to
// make one string the other
func editDistance(a, b string) int {
	x, y := []rune(a), []rune(b)
	previous := make([]int, len(y)+1)
	current := make([]int, len(y)+1)
	for j := range previous {
		previous[j] = j
	}
	for i := 1; i <= len(x); i++ {
		current[0] = i
		for j := 1; j <= len(y); j++ {
			cost := 1
			if x[i-1] == y[j-1] {
				cost = 0
			}
			current[j] = min(previous[j]+1, current[j-1]+1, previous[j-1]+cost)
		}
		previous, current = current, previous
	}
	return previous[len(y)]
}

// sourceExtensions are the files a handler's module can be, for the runtime
// that builds it: Node.js's and Python's handlers name a module, and the rest
// name a path. Without a runtime, it's either's.
func sourceExtensions(runtimeName string) (extensions []string, module bool) {
	node := []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
	switch {
	case strings.HasPrefix(runtimeName, "nodejs"):
		return node, true
	case strings.HasPrefix(runtimeName, "python"):
		return []string{".py"}, true
	case runtimeName == "":
		return append(node, ".py"), true
	}
	return nil, false
}

// hasSource is whether a handler's source is in root, for the runtime that
// builds it: a Node.js or Python handler's file is its path without the
// function's name, and a Go handler is a path itself. Without a
// runtime, either is.
func hasSource(root, handler, runtimeName string) bool {
	base := filepath.Join(root, handler)
	extensions, module := sourceExtensions(runtimeName)
	if !module || runtimeName == "" {
		if _, err := os.Stat(base); err == nil {
			return true
		}
	}
	if !module {
		return false
	}
	name := strings.TrimSuffix(base, filepath.Ext(base))
	for _, extension := range extensions {
		if info, err := os.Stat(name + extension); err == nil && !info.IsDir() {
			return true
		}
	}
	return false
}

// noSource is the error for a function whose handler has no source in root,
// with what the handler is likely meant to be
func noSource(root, name, handler, runtimeName string) error {
	expected := handler
	if extensions, module := sourceExtensions(runtimeName); module {
		path := strings.TrimSuffix(handler, filepath.Ext(handler))
		switch {
		case runtimeName == "":
			expected = path + ".ts, .js, .py or the like"
		case len(extensions) == 1:
			expected = path + extensions[0]
		default:
			expected = path + ".ts, .js or the like"
		}
	}
	message := fmt.Sprintf("the %q function's handler is %s, and the folder of Pulumi.yaml has no %s", name, handler, expected)
	if near := nearHandler(root, handler, runtimeName); near != "" {
		message += fmt.Sprintf(": did you mean %s?", near)
	}
	return fmt.Errorf("%s", message)
}

// nearHandler is a handler like the one given that has its source in root,
// with each folder or file that isn't there in its name taken as the closest
// one that is, or "" when there's none
func nearHandler(root, handler, runtimeName string) string {
	extensions, module := sourceExtensions(runtimeName)
	path, suffix := handler, ""
	if module {
		suffix = filepath.Ext(handler)
		path = strings.TrimSuffix(handler, suffix)
	}
	parts := strings.Split(filepath.ToSlash(path), "/")
	dir := root
	for i, part := range parts {
		if part == "" || part == "." || part == ".." {
			dir = filepath.Join(dir, part)
			continue
		}
		last := i == len(parts)-1
		if !last {
			if info, err := os.Stat(filepath.Join(dir, part)); err == nil && info.IsDir() {
				dir = filepath.Join(dir, part)
				continue
			}
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return ""
		}
		candidates := []string{}
		for _, entry := range entries {
			switch {
			case !last && entry.IsDir():
				candidates = append(candidates, entry.Name())
			case last && module && !entry.IsDir() && slices.Contains(extensions, filepath.Ext(entry.Name())):
				candidates = append(candidates, strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())))
			case last && !module:
				candidates = append(candidates, entry.Name())
			}
		}
		found := part
		if !slices.Contains(candidates, part) {
			found = closest(part, candidates)
		}
		if found == "" {
			return ""
		}
		parts[i] = found
		dir = filepath.Join(dir, found)
	}
	near := strings.Join(parts, "/") + suffix
	if near == handler || !hasSource(root, near, runtimeName) {
		return ""
	}
	return near
}
