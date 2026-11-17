package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/fatih/color"
	"github.com/sergi/go-diff/diffmatchpatch"
	"github.com/sst/sst/v3/cmd/sst/cli"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/js"
	"github.com/sst/sst/v3/pkg/process"
)

type codemodFinding struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	Rule    string `json:"rule"`
	Message string `json:"message"`
}

type codemodResult struct {
	Files []struct {
		File   string `json:"file"`
		Before string `json:"before"`
		After  string `json:"after"`
	} `json:"files"`
	Changes []codemodFinding `json:"changes"`
	Notes   []codemodFinding `json:"notes"`
}

// runCodemod rewrites the app's config for the 5.0 components, with the
// codemod in the platform, and writes what it changed, or prints it with
// --dry-run
func runCodemod(c *cli.Cli) error {
	p, err := c.InitProjectWithoutHome()
	if err != nil {
		return err
	}
	defer p.Cleanup()
	root := p.PathRoot()
	input, err := json.Marshal(map[string]string{
		"root":   root,
		"config": p.PathConfig(),
	})
	if err != nil {
		return err
	}
	build, err := js.Build(js.EvalOptions{
		Dir:    root,
		Define: map[string]string{"$input": string(input)},
		Code: fmt.Sprintf(
			"import { codemod } from %q;\nconsole.log(\"~j\" + JSON.stringify(codemod($input)));",
			filepath.ToSlash(filepath.Join(p.PathPlatformDir(), "src", "codemod", "index.ts")),
		),
	})
	if err != nil {
		return err
	}
	defer js.Cleanup(build)
	output, err := process.Command("node", "--no-warnings", build.OutputFiles[1].Path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("running the codemod: %w\n%s", err, output)
	}
	var result codemodResult
	found := false
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for scanner.Scan() {
		if line := scanner.Text(); strings.HasPrefix(line, "~j") {
			if err := json.Unmarshal([]byte(line[2:]), &result); err != nil {
				return fmt.Errorf("reading the codemod's answer: %w", err)
			}
			found = true
		}
	}
	if !found {
		return fmt.Errorf("the codemod gave no answer:\n%s", output)
	}

	if c.Bool("dry-run") {
		for _, f := range result.Files {
			printDiff(f.File, f.Before, f.After)
		}
		printFindings(result)
		return nil
	}

	// A file is changed only once git has what's in it, so the change can be
	// read as a diff
	if !c.Bool("force") && len(result.Files) > 0 {
		dirty := []string{}
		for _, f := range result.Files {
			if uncommitted(root, f.File) {
				dirty = append(dirty, f.File)
			}
		}
		if len(dirty) > 0 {
			return util.NewReadableError(nil, "These files have changes git hasn't committed, so the codemod leaves them as they are:\n- "+strings.Join(dirty, "\n- ")+"\nCommit them first, so its changes show as a diff, or pass --force. With --dry-run it prints the diff and writes nothing.")
		}
	}
	for _, f := range result.Files {
		path := filepath.Join(root, f.File)
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(f.After), info.Mode()); err != nil {
			return err
		}
	}
	printFindings(result)
	return nil
}

// Whether git has changes to a file it hasn't committed, or doesn't track it.
// Outside a git repo, there's nothing to compare with.
func uncommitted(root, file string) bool {
	cmd := exec.Command("git", "status", "--porcelain", "--", file)
	cmd.Dir = root
	out, err := cmd.Output()
	return err == nil && len(bytes.TrimSpace(out)) > 0
}

func printFindings(result codemodResult) {
	sort.SliceStable(result.Changes, func(i, j int) bool {
		return result.Changes[i].File < result.Changes[j].File || (result.Changes[i].File == result.Changes[j].File && result.Changes[i].Line < result.Changes[j].Line)
	})
	for _, f := range result.Changes {
		color.New(color.FgGreen, color.Bold).Print("✓ ")
		fmt.Printf(" %s:%d  %s\n", f.File, f.Line, f.Message)
	}
	for _, f := range result.Notes {
		color.New(color.FgYellow, color.Bold).Print("! ")
		fmt.Printf(" %s:%d  %s\n", f.File, f.Line, f.Message)
	}
	fmt.Println()
	switch {
	case len(result.Changes) == 0 && len(result.Notes) == 0:
		fmt.Println("Nothing to change: the config already uses the 5.0 components.")
	case len(result.Notes) == 0:
		fmt.Printf("%s. Run `sst migrate --check` on a stage next.\n", plural(len(result.Changes), "change", "changes"))
	default:
		fmt.Printf("%s, and %s to do by hand, marked !. Then run `sst migrate --check` on a stage.\n", plural(len(result.Changes), "change", "changes"), plural(len(result.Notes), "thing", "things"))
	}
}

// A file's changes, line by line
func printDiff(file, before, after string) {
	dmp := diffmatchpatch.New()
	a, b, lines := dmp.DiffLinesToChars(before, after)
	diffs := dmp.DiffCharsToLines(dmp.DiffMain(a, b, false), lines)
	color.New(color.Bold).Printf("--- %s\n+++ %s\n", file, file)
	for _, d := range diffs {
		text := strings.TrimSuffix(d.Text, "\n")
		for _, line := range strings.Split(text, "\n") {
			switch d.Type {
			case diffmatchpatch.DiffDelete:
				color.New(color.FgRed).Println("-" + line)
			case diffmatchpatch.DiffInsert:
				color.New(color.FgGreen).Println("+" + line)
			}
		}
	}
	fmt.Println()
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", one)
	}
	return fmt.Sprintf("%d %s", n, many)
}
