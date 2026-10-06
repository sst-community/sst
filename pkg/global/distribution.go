package global

// Where this distribution of the CLI is released. Upstream SST releases from
// github.com/sst/sst and publishes the npm package "sst".
const (
	ReleaseRepo = "sst-community/sst"
	NPMPackage  = "@sst-community/sst"
	// Telemetry is off: the CLI's telemetry goes to SST's own PostHog project.
	Telemetry = false
)

// CommunityPackages maps the upstream npm names that project templates install
// to this distribution's packages. They are installed under the upstream name,
// so `import { Resource } from "sst"` and `import adapter from "svelte-kit-sst"`
// keep working.
var CommunityPackages = map[string]string{
	"sst":            NPMPackage,
	"svelte-kit-sst": "@sst-community/svelte-kit-sst",
}

// AliasSpec is the package.json dependency value that installs pkg under
// another name.
func AliasSpec(pkg string, version string) string {
	return "npm:" + pkg + "@" + version
}

// NPMSpec is the package.json dependency value that installs this distribution
// under the name "sst", so `import { Resource } from "sst"` keeps working.
func NPMSpec(version string) string {
	return AliasSpec(NPMPackage, version)
}
