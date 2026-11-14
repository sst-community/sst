package golang

import (
	"os/exec"
	"testing"

	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/runtime/runtimetest"
)

// The fixture speaks the runtime API itself, so it needs no module from the
// network, as a function with aws-lambda-go would.
const fixture = `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
)

func main() {
	api := "http://" + os.Getenv("AWS_LAMBDA_RUNTIME_API") + "/2018-06-01/runtime/invocation/"
	for {
		resp, err := http.Get(api + "next")
		if err != nil {
			os.Exit(1)
		}
		var event struct{ Name string }
		json.NewDecoder(resp.Body).Decode(&event)
		resp.Body.Close()
		fmt.Println(os.Getenv("` + runtimetest.Print + `"))
		answer, _ := json.Marshal(greet(event.Name))
		http.Post(api+resp.Header.Get("Lambda-Runtime-Aws-Request-Id")+"/response", "application/json", bytes.NewReader(answer))
	}
}
`

func TestSuite(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go isn't installed")
	}
	runtimetest.Run(t, runtimetest.Options{
		Runtimes: func() []runtime.Runtime { return []runtime.Runtime{New()} },
		Files: map[string]string{
			"functions/fixture/go.mod":   "module example.com/fixture\n\ngo 1.21\n",
			"functions/fixture/main.go":  fixture,
			"functions/fixture/greet.go": "package main\n\nfunc greet(name string) map[string]string { return map[string]string{\"hello\": name} }\n",
			"functions/other/main.go":    "package main\n\nfunc main() {}\n",
		},
		Changed: map[string]string{
			"functions/fixture/greet.go": "package main\n\nfunc greet(name string) map[string]any { return map[string]any{\"hello\": name, \"again\": true} }\n",
		},
		Input:  runtime.BuildInput{Handler: "functions/fixture", Runtime: "go"},
		Uses:   "functions/fixture/greet.go",
		Unused: "functions/other/main.go",
		Broken: map[string]string{"functions/fixture/greet.go": "package main\n\nfunc greet(\n"},
	})
}
