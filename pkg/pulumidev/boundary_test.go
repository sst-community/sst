package pulumidev

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// What a Pulumi program uses of SST's project code: the program contract's
// types and the dev loop's helpers, and none of an SST app's own, like its
// home, state, passphrase, lock or bootstrap. So sst dev for Pulumi can ship
// without SST's state, and reaching for it is a decision made here.
var allowed = map[string][]string{
	"project": {
		"AddDevEnv", "AddRecords", "AssumeDevRole", "BuildFailedEvent", "BuildSuccessEvent",
		"CancelledEvent", "CompleteEvent", "Dev", "DevAws", "Devs", "Error",
		"ErrStackRunFailed", "FunctionReport", "ImportDiff", "InvalidAppRegex",
		"InvalidStageRegex", "LinkRefType", "NewRuntimes", "Program", "PublishEngineEvent",
		"ResolvePolicyPack", "StackCommandEvent", "StackInput", "Task", "Tunnel",
		"Watch",
	},
	"provider": {"AppSyncScope", "AwsProvider", "AwsRole", "NewAwsProvider", "Provider"},
}

// and what it calls on its AWS provider: never its bootstrap
var forbiddenCalls = []string{"Bootstrap", "Init"}

func TestUsesNoneOfSSTsState(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, spec := range parsed.Imports {
			path := strings.Trim(spec.Path.Value, `"`)
			if strings.HasPrefix(path, "github.com/sst/sst/v3/pkg/state") || strings.HasPrefix(path, "github.com/sst/sst/v3/pkg/move") {
				t.Errorf("%s imports %s", file, path)
			}
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			name := selector.Sel.Name
			if pkg, ok := selector.X.(*ast.Ident); ok {
				if names, ok := allowed[pkg.Name]; ok && !slices.Contains(names, name) {
					t.Errorf("%s uses %s.%s", fset.Position(selector.Pos()), pkg.Name, name)
				}
			}
			if slices.Contains(forbiddenCalls, name) {
				t.Errorf("%s calls %s", fset.Position(selector.Pos()), name)
			}
			return true
		})
	}
}
