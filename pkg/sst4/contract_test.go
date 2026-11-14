package sst4

import (
	"context"
	"encoding/json"
	"errors"
	"net/rpc"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/sst/sst/v3/pkg/js"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/common"
)

// The engine speaks this contract to a platform that declares version 0
func TestRegistered(t *testing.T) {
	contract, err := project.ContractFor(&js.PlatformManifest{Contract: new(0)})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := contract.(Contract); !ok {
		t.Fatalf("version 0 is %T", contract)
	}
	if !contract.LoadsProvidersForApp() {
		t.Fatal("SST 4's line leaves the providers out of reading app(), which SST 4.25.0 loaded")
	}
}

func ptr[T any](v T) *T { return &v }

// SST 4's output names are read as the same items as SST 5's record
func TestReadReport(t *testing.T) {
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
	want := &project.Report{
		Function: &project.FunctionReport{Handler: "src/server.handler", Dev: true},
		Dev: &project.Dev{
			Command:     "npm run dev",
			Directory:   "web",
			Environment: map[string]string{"MODE": "local"},
			Autostart:   true,
			Links:       []string{"Docs"},
			Aws:         &project.DevAws{},
		},
		Task:   &project.Task{Command: ptr("node seed.js"), Directory: "scripts"},
		Tunnel: &project.Tunnel{IP: "10.0.0.1", Username: "ec2-user", PrivateKey: "key", Subnets: []string{"10.0.0.0/16"}},
		Hint:   "https://shop-dev-webbucket-drrmzcfu.example.com",
	}
	if report := readReport(outputs); !reflect.DeepEqual(report, want) {
		t.Fatalf("read %+v", report)
	}
}

// SST 5's record isn't SST 4's, and an item of the wrong kind is nothing
func TestReadReportNothing(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "contract", "report-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]interface{}
	json.Unmarshal(data, &record)
	for _, outputs := range []map[string]interface{}{
		{},
		{"url": "https://example.com"},
		{"_hint": 5, "_dev": "npm run dev"},
		{"_metadata": map[string]interface{}{"url": "https://example.com"}},
		{"_sst": record},
	} {
		if report := readReport(outputs); report != nil {
			t.Fatalf("%v: read %+v", outputs, report)
		}
	}
}

// A component that reports as SST 5's do, with a record (_sst), is read on
// SST 4's line too, so one of a package's can report the same way on either.
// A record wins over SST 4's output names, and one from a newer contract
// stops the read, as on SST 5's line.
func TestReadSST5Record(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "contract", "report-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]interface{}
	json.Unmarshal(data, &record)
	urn := resource.URN("urn:pulumi:dev::shop::pkg:index:Web::Web")

	complete := newComplete()
	res := apitype.ResourceV3{URN: urn, Type: "pkg:index:Web"}
	if err := (Contract{}).Read(complete, res, map[string]interface{}{"_sst": record}); err != nil {
		t.Fatal(err)
	}
	if complete.Devs["Web"].Command != "npm run dev" || complete.Functions["Web"].Handler != "src/server.handler" || complete.Tasks["Web"].Directory != "scripts" || complete.Tunnels["Web"].IP != "10.0.0.1" || complete.Hints[string(urn)] != "https://shop-dev-webbucket-drrmzcfu.example.com" {
		t.Fatalf("read %+v", complete)
	}

	complete = newComplete()
	both := map[string]interface{}{"_sst": record, "_hint": "https://sst4.example.com", "_dev": map[string]interface{}{"command": "sst4"}}
	if err := (Contract{}).Read(complete, res, both); err != nil {
		t.Fatal(err)
	}
	if complete.Hints[string(urn)] != "https://shop-dev-webbucket-drrmzcfu.example.com" || complete.Devs["Web"].Command != "npm run dev" {
		t.Fatalf("SST 4's names were read over the record: %+v", complete)
	}

	// A record from a newer contract is left out, and SST 4's names are read
	complete = newComplete()
	newer := map[string]interface{}{"_sst": map[string]interface{}{"contract": float64(2), "hint": "x"}, "_hint": "https://sst4.example.com"}
	if err := (Contract{}).Read(complete, res, newer); err != nil {
		t.Fatalf("a record from a newer contract stopped the read: %v", err)
	}
	if complete.Hints[string(urn)] != "https://sst4.example.com" {
		t.Fatalf("read %+v", complete.Hints)
	}
}

var recordedStates = []string{"serverless-sites", "vpc-containers-databases", "serverless-dev"}

func recordedResources(t *testing.T, name string) []apitype.ResourceV3 {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "states", "v4.23.1", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Checkpoint apitype.CheckpointV3 `json:"checkpoint"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state.Checkpoint.Latest.Resources
}

// newComplete is what a run reads a state into
func newComplete() *project.CompleteEvent {
	return &project.CompleteEvent{
		Links:     common.Links{},
		Devs:      project.Devs{},
		Functions: map[string]project.FunctionReport{},
		Tasks:     map[string]project.Task{},
		Tunnels:   map[string]project.Tunnel{},
		Hints:     map[string]string{},
	}
}

// Every component in the states SST 4 left in the lab is read as SST 4's CLI
// read it: the same functions, dev commands, tasks, tunnels and hints, and
// the same versions
func TestReadRecordedStates(t *testing.T) {
	for _, name := range recordedStates {
		resources := recordedResources(t, name)
		complete := newComplete()
		was := oldReading{functions: map[string]bool{}, devs: map[string]bool{}, tasks: map[string]bool{}, tunnels: map[string]bool{}, hints: map[string]string{}}
		for _, r := range resources {
			outputs, ok := r.Outputs, true
			if outputs == nil {
				outputs, ok = map[string]interface{}{}, false
			}
			was.read(r.URN, string(r.Type), r.Custom, outputs)
			if !ok {
				continue
			}
			if err := (Contract{}).Read(complete, r, outputs); err != nil {
				t.Fatalf("%v: %v", name, err)
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
			t.Fatalf("%v: SST 4 read\n%+v\nthe core reads\n%+v", name, was, now)
		}
		want := mainVersions(resources)
		got, _ := complete.Contract.(Versions)
		if len(want) == 0 || !reflect.DeepEqual(map[string]int(got), want) {
			t.Fatalf("%v: SST 4 read the versions\n%v\nthe core reads\n%v", name, want, got)
		}
		if len(complete.Links) == 0 {
			t.Fatalf("%v: no links read", name)
		}
	}
}

// What SST 4's CLI read from a component: the functions its sst dev UI
// listed, by their type, and the rest by the output it names for each
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

// main's getCompletedEvent, for the versions alone
func mainVersions(resources []apitype.ResourceV3) map[string]int {
	versions := map[string]int{}
	for _, resource := range resources {
		outputs := resource.Outputs
		if outputs == nil {
			continue
		}
		if resource.URN.Type().Module().Package().Name() == "sst" {
			if resource.Type == "sst:sst:Version" {
				target, targetOk := outputs["target"].(string)
				version, versionOk := outputs["version"].(float64)
				if targetOk && versionOk {
					versions[target] = int(version)
				}
			}
			if resource.Type != "sst:sst:Version" {
				name := resource.URN.Name()
				if _, ok := versions[name]; !ok {
					versions[name] = 1
				}
			}
		}
	}
	return versions
}

func sortedKeys[V any](m map[string]V) []string {
	keys := []string{}
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// $cli is what SST 4's CLI gave: its keys, the paths, and the versions
func TestDefine(t *testing.T) {
	p := &project.Project{}
	define, err := Contract{}.Define(p, &project.StackInput{Command: "deploy", Dev: true}, project.StageState{
		Components: map[string]int{"sst:aws:Bucket": 1},
		Contract:   Versions{"Api": 2, "Web": 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if keys := sortedKeys(define); !reflect.DeepEqual(keys, []string{"$app", "$cli", "$dev"}) {
		t.Fatalf("the program gets %v", keys)
	}
	if define["$dev"] != "true" {
		t.Fatalf("$dev is %v", define["$dev"])
	}
	var cli map[string]interface{}
	if err := json.Unmarshal([]byte(define["$cli"]), &cli); err != nil {
		t.Fatal(err)
	}
	if keys := sortedKeys(cli); !reflect.DeepEqual(keys, []string{"command", "dev", "paths", "state"}) {
		t.Fatalf("$cli has %v", keys)
	}
	paths := cli["paths"].(map[string]interface{})
	if keys := sortedKeys(paths); !reflect.DeepEqual(keys, []string{"home", "platform", "root", "work"}) {
		t.Fatalf("$cli.paths has %v", keys)
	}
	state := cli["state"].(map[string]interface{})
	if !reflect.DeepEqual(state, map[string]interface{}{"version": map[string]interface{}{"Api": 2.0, "Web": 1.0}}) {
		t.Fatalf("$cli.state is %v", state)
	}

	// and an empty state's versions are an object, not null
	define, _ = Contract{}.Define(p, &project.StackInput{Command: "deploy"}, project.StageState{})
	json.Unmarshal([]byte(define["$cli"]), &cli)
	if version, ok := cli["state"].(map[string]interface{})["version"].(map[string]interface{}); !ok || len(version) != 0 {
		t.Fatalf("$cli.state.version is %v", cli["state"])
	}
}

// SST 4's line runs on a stage SST 4 deployed, and refuses one that moved, but
// for a diff, and a move
func TestRefuse(t *testing.T) {
	p := &project.Project{}
	unmoved := project.StageState{Types: []string{"sst:aws:Function"}}
	moved := project.StageState{Moved: true, Types: []string{"sst:aws:Function"}}
	for _, command := range []string{"deploy", "remove", "refresh", "diff"} {
		if err := (Contract{}).Refuse(p, &project.StackInput{Command: command}, unmoved); err != nil {
			t.Fatalf("%v on an unmoved stage: %v", command, err)
		}
		err := Contract{}.Refuse(p, &project.StackInput{Command: command}, moved)
		if (command == "diff") != (err == nil) {
			t.Fatalf("%v on a moved stage: %v", command, err)
		}
	}
	if err := (Contract{}).Refuse(p, &project.StackInput{Command: "deploy", Move: true}, unmoved); err == nil {
		t.Fatal("a move ran on SST 4's line")
	}
	// and a move stops before anything is read
	if err := (Contract{}).Begin(p, nil, nil, &project.StackInput{Command: "deploy", Move: true}); !errors.Is(err, errMove) {
		t.Fatalf("a move began: %v", err)
	}
	if err := (Contract{}).Begin(p, nil, nil, &project.StackInput{Command: "deploy"}); err != nil {
		t.Fatal(err)
	}
}

// A stage with the tombstone is on SST 5's components
func TestRefuseTombstone(t *testing.T) {
	if err := refuseTombstone(true, nil); !errors.Is(err, ErrStageOnSST5) {
		t.Fatalf("a stage with the tombstone ran: %v", err)
	}
	if err := refuseTombstone(false, nil); err != nil {
		t.Fatal(err)
	}
	read := errors.New("can't read the lock")
	if err := refuseTombstone(false, read); !errors.Is(err, read) {
		t.Fatalf("the read's error is %v", err)
	}
}

// A stage the app gives a target is stopped, not deployed to the real cloud
func TestRefuseTarget(t *testing.T) {
	err := (Contract{}).RefuseTarget("local")
	if err == nil {
		t.Fatal("a stage with a target ran on SST 4's components")
	}
	if want := `The "local" stage has a target in app(), and SST 4's components deploy only to the cloud. Targets come with SST 5.`; err.Error() != want {
		t.Fatalf("the refusal is %q", err.Error())
	}
}

func TestHoldsNoProviderMajors(t *testing.T) {
	if (Contract{}).HoldsProviderMajors() {
		t.Fatal("SST 4 refused a provider's other major version")
	}
}

// probe is a service whose one method net/rpc takes, so registering it under
// a name fails only when the name is taken
type probe struct{}

func (probe) Call(input *struct{}, output *struct{}) error { return nil }

// The RPC serves what SST 4.25.0's CLI served SST 4's components, by name
func TestRegisterRPC(t *testing.T) {
	server := rpc.NewServer()
	Contract{}.RegisterRPC(context.Background(), &project.Project{}, server)
	for _, name := range []string{
		"Resource.Run",
		"Resource.Aws.BucketFiles",
		"Resource.Aws.DistributionDeploymentWaiter",
		"Resource.Aws.DistributionInvalidation",
		"Resource.Aws.FunctionCodeUpdater",
		"Resource.Aws.FunctionEnvironmentUpdate",
		"Resource.Aws.HostedZoneLookup",
		"Resource.Aws.KvKeys",
		"Resource.Aws.KvRoutesUpdate",
		"Resource.Aws.MicrovmImagePrune",
		"Resource.Aws.OriginAccessIdentity",
		"Resource.Aws.OriginAccessControl",
		"Resource.Aws.RdsRoleLookup",
		"Resource.Aws.VectorTable",
		"Resource.Cloudflare.DnsRecord",
		"Resource.Cloudflare.WorkerAssets",
		"Resource.Cloudflare.WorkerScript",
		"Resource.Vercel.DnsRecord",
		"Provider.Aws",
	} {
		if err := server.RegisterName(name, probe{}); err == nil {
			t.Errorf("%v isn't served", name)
		}
	}
	// and nothing of SST 5's program contract
	if err := server.RegisterName("Move", probe{}); err != nil {
		t.Errorf("Move is served: %v", err)
	}
}
