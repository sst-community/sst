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
	report, err := readReport(map[string]interface{}{"_sst": record, "url": "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(report, wantReport) {
		t.Fatalf("read %+v", report)
	}
}

// 4.x's output names are read as the same items as a record.
func TestReadReportLegacy(t *testing.T) {
	var outputs map[string]interface{}
	json.Unmarshal([]byte(`{
		"_metadata": {"handler": "src/server.handler", "dev": true},
		"_dev": {"command": "npm run dev", "directory": "web", "environment": {"MODE": "local"}, "autostart": true, "links": ["Docs"], "aws": {}},
		"_task": {"command": "node seed.js", "directory": "scripts"},
		"_tunnel": {"ip": "10.0.0.1", "username": "ec2-user", "privateKey": "key", "subnets": ["10.0.0.0/16"]},
		"_hint": "https://shop-dev-webbucket-drrmzcfu.example.com",
		"_live": {"functionID": "Web"},
		"url": "https://example.com"
	}`), &outputs)
	report, err := readReport(outputs)
	if err != nil {
		t.Fatal(err)
	}
	want := *wantReport
	want.Contract = 0
	dev := *want.Dev
	dev.Aws = &struct {
		Role string `json:"role"`
	}{}
	want.Dev = &dev
	if !reflect.DeepEqual(report, &want) {
		t.Fatalf("read %+v", report)
	}
}

func TestReadReportNothing(t *testing.T) {
	for _, outputs := range []map[string]interface{}{
		{},
		{"url": "https://example.com"},
		// as before, an item of the wrong kind is nothing
		{"_hint": 5, "_dev": "npm run dev"},
	} {
		report, err := readReport(outputs)
		if err != nil || report != nil {
			t.Fatalf("%v: read %+v, %v", outputs, report, err)
		}
	}
}

func TestReadReportNewerContract(t *testing.T) {
	_, err := readReport(map[string]interface{}{"_sst": map[string]interface{}{"contract": float64(2), "hint": "x"}})
	var newer *ErrNewerContract
	if !errors.As(err, &newer) || newer.Version != 2 {
		t.Fatalf("got %v", err)
	}
}

// A field of the wrong type is left out, and the rest is read.
func TestReadReportWrongType(t *testing.T) {
	report, err := readReport(map[string]interface{}{"_sst": map[string]interface{}{
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

// Every component in the states 4.x left in the lab is read as before: the
// same functions, dev commands, tasks, tunnels and hints as the reading this
// replaced, which is copied in below.
func TestReadReportRecordedStates(t *testing.T) {
	for _, name := range []string{"serverless-sites", "vpc-containers-databases", "serverless-dev"} {
		state := readJSON(t, filepath.Join("..", "..", "testdata", "states", "v4.23.1", name+".json"))
		resources := state["checkpoint"].(map[string]interface{})["latest"].(map[string]interface{})["resources"].([]interface{})
		complete := &CompleteEvent{
			Devs:      Devs{},
			Functions: map[string]FunctionReport{},
			Tasks:     map[string]Task{},
			Tunnels:   map[string]Tunnel{},
			Hints:     map[string]string{},
		}
		was := oldReading{functions: map[string]bool{}, devs: map[string]bool{}, tasks: map[string]bool{}, tunnels: map[string]bool{}, hints: map[string]string{}}
		for _, r := range resources {
			r := r.(map[string]interface{})
			urn := resource.URN(r["urn"].(string))
			outputs, _ := r["outputs"].(map[string]interface{})
			was.read(urn, r["type"].(string), r["custom"] == true, outputs)
			report, err := readReport(outputs)
			if err != nil {
				t.Fatalf("%v: %v", name, err)
			}
			if report != nil {
				complete.add(urn, report)
			}
		}
		now := oldReading{functions: map[string]bool{}, devs: map[string]bool{}, tasks: map[string]bool{}, tunnels: map[string]bool{}, hints: complete.Hints}
		for fn := range complete.Functions {
			now.functions[fn] = true
		}
		for dev := range complete.Devs {
			now.devs[dev] = true
		}
		for task := range complete.Tasks {
			now.tasks[task] = true
		}
		for tunnel := range complete.Tunnels {
			now.tunnels[tunnel] = true
		}
		if len(was.functions) == 0 || len(was.hints) == 0 || !reflect.DeepEqual(was, now) {
			t.Fatalf("%v: read before\n%+v\nnow\n%+v", name, was, now)
		}
	}
}

// What the core read from a component before the program contract: the
// functions the sst dev UI listed, by their type, and the rest by the output
// 4.x names for it.
type oldReading struct {
	functions, devs, tasks, tunnels map[string]bool
	hints                           map[string]string
}

func (o oldReading) read(urn resource.URN, t string, custom bool, outputs map[string]interface{}) {
	name := urn.Name()
	if !custom && (t == "sst:aws:Function" || t == "sst:cloudflare:Worker") {
		o.functions[name] = true
	}
	if _, ok := outputs["_dev"].(map[string]interface{}); ok {
		o.devs[name] = true
	}
	if _, ok := outputs["_task"].(map[string]interface{}); ok {
		o.tasks[name] = true
	}
	if tunnel, ok := outputs["_tunnel"].(map[string]interface{}); ok {
		_, ip := tunnel["ip"].(string)
		_, username := tunnel["username"].(string)
		_, key := tunnel["privateKey"].(string)
		_, subnets := tunnel["subnets"].([]interface{})
		if ip && username && key && subnets {
			o.tunnels[name] = true
		}
	}
	if hint, ok := outputs["_hint"].(string); ok {
		o.hints[string(urn)] = hint
	}
}
