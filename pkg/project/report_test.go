package project

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
)

// The record in testdata/contract, which the platform's contract test checks
// it writes, as the core reads it.
var wantReport = &Report{
	Contract: 1,
	Function: &FunctionReport{Handler: "src/server.handler", Dev: true},
	Dev: &Dev{
		Command:     "npm run dev",
		Directory:   "web",
		Environment: map[string]string{"MODE": "local"},
		Autostart:   true,
		Links:       []string{"Docs"},
	},
	Task:   &Task{Command: ptr("node seed.js"), Directory: "scripts"},
	Tunnel: &Tunnel{IP: "10.0.0.1", Username: "ec2-user", PrivateKey: "key", Subnets: []string{"10.0.0.0/16"}},
	Hint:   "https://shop-dev-webbucket-drrmzcfu.example.com",
}

func ptr[T any](v T) *T { return &v }

func readJSON(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestReadReportRecord(t *testing.T) {
	record := readJSON(t, filepath.Join("..", "..", "testdata", "contract", "report-v1.json"))
	report, err := ReadReport(map[string]interface{}{"_sst": record, "url": "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(report, wantReport) {
		t.Fatalf("read %+v", report)
	}
}

func TestReadReportNothing(t *testing.T) {
	for _, outputs := range []map[string]interface{}{
		{},
		{"url": "https://example.com"},
		// a record of the wrong kind
		{"_sst": "npm run dev"},
		// SST 4's output names, which only its components wrote
		{
			"_metadata": map[string]interface{}{"handler": "src/server.handler", "dev": true},
			"_dev":      map[string]interface{}{"command": "npm run dev", "directory": "web"},
			"_task":     map[string]interface{}{"command": "node seed.js"},
			"_tunnel":   map[string]interface{}{"ip": "10.0.0.1"},
			"_hint":     "https://example.com",
		},
	} {
		report, err := ReadReport(outputs)
		if err != nil || report != nil {
			t.Fatalf("%v: read %+v, %v", outputs, report, err)
		}
	}
}

func TestReadReportNewerContract(t *testing.T) {
	_, err := ReadReport(map[string]interface{}{"_sst": map[string]interface{}{"contract": float64(2), "hint": "x"}})
	var newer *ErrNewerContract
	if !errors.As(err, &newer) || newer.Version != 2 {
		t.Fatalf("got %v", err)
	}
}

// A field of the wrong type is left out, and the rest is read.
func TestReadReportWrongType(t *testing.T) {
	report, err := ReadReport(map[string]interface{}{"_sst": map[string]interface{}{
		"contract": float64(1),
		"dev":      map[string]interface{}{"command": float64(5), "directory": "web"},
		"hint":     "https://example.com",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if report.Dev == nil || report.Dev.Command != "" || report.Dev.Directory != "web" || report.Hint != "https://example.com" {
		t.Fatalf("read %+v", report)
	}
}

func TestCompleteAdd(t *testing.T) {
	complete := &CompleteEvent{
		Devs:      Devs{},
		Functions: map[string]FunctionReport{},
		Tasks:     map[string]Task{},
		Tunnels:   map[string]Tunnel{},
		Hints:     map[string]string{},
	}
	urn := resource.URN("urn:pulumi:dev::shop::acme:index:Site::Web")
	complete.add(urn, wantReport)
	if complete.Functions["Web"].Handler != "src/server.handler" {
		t.Fatalf("functions %v", complete.Functions)
	}
	if complete.Devs["Web"].Name != "Web" || complete.Devs["Web"].Command != "npm run dev" {
		t.Fatalf("devs %v", complete.Devs)
	}
	if complete.Tasks["Web"].Name != "Web" {
		t.Fatalf("tasks %v", complete.Tasks)
	}
	if complete.Tunnels["Web"].IP != "10.0.0.1" {
		t.Fatalf("tunnels %v", complete.Tunnels)
	}
	if complete.Hints[string(urn)] != wantReport.Hint {
		t.Fatalf("hints %v", complete.Hints)
	}

	// a tunnel without its key is of no use
	other := resource.URN("urn:pulumi:dev::shop::acme:index:Site::Other")
	complete.add(other, &Report{Tunnel: &Tunnel{IP: "10.0.0.2", Username: "ec2-user"}})
	if _, ok := complete.Tunnels["Other"]; ok {
		t.Fatal("a tunnel without its key was added")
	}
}

// A stage SST 4 deployed reports nothing, though its components named
// functions, dev commands and hints as outputs of their own: the core reads
// only records.
func TestReadReportRecordedStates(t *testing.T) {
	for _, name := range []string{"serverless-sites", "vpc-containers-databases", "serverless-dev"} {
		state := readJSON(t, filepath.Join("..", "..", "testdata", "states", "v4.23.1", name+".json"))
		resources := state["checkpoint"].(map[string]interface{})["latest"].(map[string]interface{})["resources"].([]interface{})
		named := 0
		for _, r := range resources {
			outputs, _ := r.(map[string]interface{})["outputs"].(map[string]interface{})
			if _, ok := outputs["_hint"]; ok {
				named++
			}
			report, err := ReadReport(outputs)
			if err != nil || report != nil {
				t.Fatalf("%v: read %+v, %v", name, report, err)
			}
		}
		if named == 0 {
			t.Fatalf("%v: no component named a hint", name)
		}
	}
}
