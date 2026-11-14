package project

import (
	"context"
	"encoding/json"
	"errors"
	"net/rpc"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/sst/sst/v3/pkg/js"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// SST 5's platform's manifest, as platform/package.json has it on v5. The
// tests of the program contract use it, whichever platform this build has:
// a build with SST 4's runs them too.
var sst5Manifest = &js.PlatformManifest{
	Contract: 1,
	Types: js.PlatformTypes{
		Global: []string{"global.d.ts", "global-aliases.d.ts"},
		Config: "config.js",
		Paths:  map[string]string{"sst/testing": "testing/index"},
	},
	Modules: map[string]string{
		"sst/components":            "components/core",
		"sst/components/aws":        "components/aws/index",
		"sst/components/cloudflare": "components/cloudflare/index",
		"sst/components/vercel":     "components/vercel/index",
	},
}

// The modules of SST 5's platform, as checkPackages is given them
var sst5Modules = (&Project{manifest: sst5Manifest}).platformModules()

// sst5 is a project on SST 5's platform, as New makes one
func sst5(p *Project) *Project {
	p.manifest = sst5Manifest
	p.contract = programContract{}
	return p
}

// The manifest the tests use is the one SST 5's platform has, when this build
// has SST 5's platform
func TestSST5ManifestIsThePlatforms(t *testing.T) {
	manifest, err := EmbeddedManifest()
	require.NoError(t, err)
	require.NotNil(t, manifest, "platform/package.json has `sst`")
	if manifest.Contract != ContractVersion {
		t.Skipf("this build's platform speaks contract %d", manifest.Contract)
	}
	assert.Equal(t, sst5Manifest, manifest)
}

func TestContractFor(t *testing.T) {
	contract, err := ContractFor(sst5Manifest)
	require.NoError(t, err)
	assert.Equal(t, 1, contract.Version())

	_, err = ContractFor(nil)
	assert.ErrorContains(t, err, "doesn't say which components it has")

	_, err = ContractFor(&js.PlatformManifest{Contract: 9})
	assert.ErrorContains(t, err, "speaks version 9 of the program contract")
}

// fakeContract is SST 5's, but reads a state as SST 4's does: a function
// from `_metadata`, and what it keeps for itself, a version for each
// component, by name. Locked refuses the stage when refuse is set.
type fakeContract struct {
	programContract
	refuse error
}

func (fakeContract) Read(complete *CompleteEvent, res apitype.ResourceV3, outputs map[string]interface{}) error {
	var report *Report
	if metadata, ok := outputs["_metadata"].(map[string]interface{}); ok {
		report = &Report{Function: &FunctionReport{Handler: metadata["handler"].(string)}}
	}
	complete.AddRecords(res.URN, string(res.Type), outputs, report)
	versions, _ := complete.Contract.(map[string]int)
	if versions == nil {
		versions = map[string]int{}
		complete.Contract = versions
	}
	versions[res.URN.Name()] = 1
	return nil
}

func (f fakeContract) Locked(p *Project) error { return f.refuse }

// What the contract reads is read with the state, before the event is
// published: sst dev's server encodes the event as the run goes on, and a
// read after it that wrote to the event crashed sst dev ("concurrent map
// iteration and map write") on SST 4's line in the lab. Run with -race.
func TestContractReadsWithTheState(t *testing.T) {
	root := t.TempDir()
	p := sst5(&Project{root: root, config: filepath.Join(root, "sst.config.ts"), app: &App{Name: "my-app", Stage: "dev"}})
	p.contract = fakeContract{}
	workdir, err := p.NewWorkdir("test")
	require.NoError(t, err)
	stack := resource.URN("urn:pulumi:dev::my-app::pulumi:pulumi:Stack::my-app-dev")
	resources := []apitype.ResourceV3{
		{URN: stack, Type: "pulumi:pulumi:Stack", Outputs: map[string]interface{}{"url": "https://example.com"}},
		{URN: "urn:pulumi:dev::my-app::sst:aws:Function::Api", Type: "sst:aws:Function", Parent: stack, Outputs: map[string]interface{}{"_metadata": map[string]interface{}{"handler": "src/api.handler"}}},
		{URN: "urn:pulumi:dev::my-app::sst:aws:Vpc::Net", Type: "sst:aws:Vpc", Parent: stack, Outputs: map[string]interface{}{"_tunnel": map[string]interface{}{"ip": "10.0.0.1"}}},
	}
	// where a pull leaves the state
	require.NoError(t, os.MkdirAll(filepath.Dir(workdir.state()), 0755))
	require.NoError(t, workdir.Import(&apitype.CheckpointV3{Stack: "organization/my-app/dev", Latest: &apitype.DeploymentV3{Resources: resources}}))

	complete, err := getCompletedEvent(context.Background(), "passphrase", workdir, p.contract)
	require.NoError(t, err)
	want := map[string]int{"my-app-dev": 1, "Api": 1, "Net": 1}
	require.Equal(t, want, complete.Contract)
	require.Contains(t, complete.Functions, "Api")
	// as sst dev's server encodes it while the run reads the stage
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			json.Marshal(complete)
		}
	}()
	for i := 0; i < 200; i++ {
		require.Equal(t, want, stageState(complete).Contract)
	}
	<-done
}

// A stage the contract refuses once it's locked is unlocked, and the run it
// was locked for leaves no update
func TestLockReleasesAStageTheContractRefuses(t *testing.T) {
	home := provider.NewLocalHomeAt(t.TempDir())
	p := sst5(&Project{app: &App{Name: "my-app", Stage: "dev"}, home: home, version: "4.25.0"})
	refused := errors.New("refused")
	p.contract = fakeContract{refuse: refused}
	_, err := p.Lock("deploy")
	require.ErrorIs(t, err, refused)
	updates, err := provider.ListUpdates(home, "my-app", "dev")
	require.NoError(t, err)
	assert.Empty(t, updates)
	// the stage isn't locked
	p.contract = programContract{}
	update, err := p.Lock("deploy")
	require.NoError(t, err)
	require.NoError(t, p.Unlock())
	assert.NotEmpty(t, update.ID)
}

// SST 4's platform, as its manifest has it on main: no modules to import
var sst4Manifest = &js.PlatformManifest{
	Contract: 0,
	Types:    js.PlatformTypes{Global: []string{"global.d.ts"}, Config: "config"},
}

// A platform with no modules, as SST 4's, gets the types SST 4 wrote, no
// .sst/tsconfig.json, and no platform modules in its builds
func TestPlatformWithoutModules(t *testing.T) {
	root := t.TempDir()
	p := &Project{root: root, config: filepath.Join(root, "sst.config.ts"), app: &App{Name: "my-app", Stage: "dev"}, manifest: sst4Manifest}
	require.NoError(t, os.MkdirAll(p.PathPlatformDir(), 0755))

	require.NoError(t, p.writeTypes())
	data, err := os.ReadFile(filepath.Join(p.PathPlatformDir(), "config.d.ts"))
	require.NoError(t, err)
	lines := strings.SplitN(string(data), "\n", 4)
	assert.Equal(t, []string{
		`import "./src/global.d.ts"`,
		`import "../types.generated"`,
		`import { AppInput, App, Config } from "./src/config"`,
	}, lines[:3])

	require.NoError(t, p.writeTsconfig())
	_, err = os.Stat(filepath.Join(p.PathWorkingDir(), "tsconfig.json"))
	assert.True(t, os.IsNotExist(err), "no tsconfig.json")

	_, platform := p.programGlobals()
	assert.Empty(t, platform)
}

// SST 5's gets the types it always has
func TestPlatformTypes(t *testing.T) {
	root := t.TempDir()
	p := sst5(&Project{root: root, config: filepath.Join(root, "sst.config.ts"), app: &App{Name: "my-app", Stage: "dev"}})
	require.NoError(t, os.MkdirAll(p.PathPlatformDir(), 0755))
	require.NoError(t, p.writeTypes())
	data, err := os.ReadFile(filepath.Join(p.PathPlatformDir(), "config.d.ts"))
	require.NoError(t, err)
	lines := strings.SplitN(string(data), "\n", 5)
	assert.Equal(t, []string{
		`import "./src/global.d.ts"`,
		`import "./src/global-aliases.d.ts"`,
		`import "../types.generated"`,
		`import { AppInput, App, Config } from "./src/config.js"`,
	}, lines[:4])
}

// A project without a contract stops at once, loudly: run on, SST 4's
// components would take what the RPC doesn't serve as done
func TestNoContractStops(t *testing.T) {
	p := &Project{app: &App{Name: "my-app", Stage: "dev"}, home: provider.NewLocalHomeAt(t.TempDir())}
	stops := "the project has no program contract: a Project is made with project.New, which gives it its platform's"
	assert.PanicsWithValue(t, stops, func() { p.RegisterRPC(context.Background(), rpc.NewServer()) })
	assert.PanicsWithValue(t, stops, func() { p.Lock("deploy") })
}
