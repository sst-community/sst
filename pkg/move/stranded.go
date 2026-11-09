package move

import (
	"fmt"
	"sort"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
)

// Stranded is a component of SST 4's that a stage has, which has no 5.0 form,
// and what to do about it. A move can't take it over, and can't delete it
// either, so it's dealt with on SST 4 before the stage moves. The codemod's
// lists say the same of an app's config (platform/src/codemod/names.ts,
// `leftOut` and `v1`); keep the two in step.
type Stranded struct {
	Name string
	Type string
	What string
	// In is the component it's inside, named when another one listed has the
	// same name
	In string
}

func (s Stranded) String() string {
	if s.In != "" {
		return fmt.Sprintf("%q, in %q, is %s", s.Name, s.In, s.What)
	}
	return fmt.Sprintf("%q is %s", s.Name, s.What)
}

// What each type with no 5.0 form is, and what to do about it
var leftOut = map[string]string{
	"sst:aws:Cron":              "SST 4's first `Cron`, which has no 5.0 form: move it to `sst.aws.CronV2` with SST 4, which is `Cron` in 5.0.",
	"sst:aws:OpenControl":       "an `OpenControl`, which has no 5.0 form: remove it with SST 4, and run OpenControl outside of SST.",
	"sst:aws:Vector":            "a `Vector`, which has no 5.0 form: move its vectors to a vector database of their own, and remove it, with SST 4.",
	"sst:cloudflare:Auth":       "Cloudflare's `Auth`, which has no 5.0 form: remove it with SST 4, or keep the stage on SST 4.",
	"sst:cloudflare:SolidStart": "Cloudflare's experimental `SolidStart`, which has no 5.0 form: remove it with SST 4, or keep the stage on SST 4.",
}

// The first of Cloudflare's `StaticSite`s has the type `StaticSiteV2` has, and
// is told apart by the `Kv` it keeps its files in
const (
	cloudflareSite      = "sst:cloudflare:StaticSite"
	cloudflareSiteKv    = "sst:cloudflare:Kv"
	firstCloudflareSite = "Cloudflare's first `StaticSite`, which has no 5.0 form: move it to `sst.cloudflare.StaticSiteV2` with SST 4, which is `StaticSite` in 5.0."
)

// The `.v1` forms have the type of the components' current versions, which
// record their version, 2, in a `sst:sst:Version` inside them. A `.v1` has
// none.
var v1 = map[string]string{
	"sst:aws:Auth":     "an `Auth.v1`, which has no 5.0 form: move it to OpenAuth's `Auth`, `sst.aws.Auth`, with SST 4.",
	"sst:aws:Vpc":      "a `Vpc.v1`, which has no 5.0 form: move it to `sst.aws.Vpc`, its current version, with SST 4.",
	"sst:aws:Cluster":  "a `Cluster.v1`, which has no 5.0 form: move it to `sst.aws.Cluster`, its current version, with SST 4.",
	"sst:aws:Postgres": "a `Postgres.v1`, which has no 5.0 form: move it to `sst.aws.Postgres`, its current version, with SST 4.",
	"sst:aws:Redis":    "a `Redis.v1`, which has no 5.0 form: move it to `sst.aws.Redis`, its current version, with SST 4.",
}

const versionMarker = "sst:sst:Version"

// FindStranded lists the components of SST 4's in a state that have no 5.0
// form, by name. Only a state SST 4 deployed is read this way: SST 5's own
// components have the `.v1` forms' types and no version marker. One inside
// another of SST's components, like the `Cron` that warms a site, moves with
// that one, and isn't listed.
func FindStranded(resources []apitype.ResourceV3) []Stranded {
	children := map[string][]string{}
	for _, res := range resources {
		if res.Parent != "" {
			children[string(res.Parent)] = append(children[string(res.Parent)], string(res.Type))
		}
	}
	has := func(res apitype.ResourceV3, typ string) bool {
		for _, child := range children[string(res.URN)] {
			if child == typ {
				return true
			}
		}
		return false
	}

	found := []Stranded{}
	for _, res := range resources {
		if res.Custom || insideSST(res) {
			continue
		}
		typ := string(res.Type)
		what, ok := leftOut[typ]
		if !ok && typ == cloudflareSite && has(res, cloudflareSiteKv) {
			what, ok = firstCloudflareSite, true
		}
		if !ok && v1[typ] != "" && !has(res, versionMarker) {
			what, ok = v1[typ], true
		}
		if ok {
			in := ""
			if res.Parent != "" && res.Parent.QualifiedType() != "pulumi:pulumi:Stack" {
				in = res.Parent.Name()
			}
			found = append(found, Stranded{Name: res.URN.Name(), Type: typ, What: what, In: in})
		}
	}
	// SST 4's `Vector.get(name, id)` looks up its database as a `Postgres.v1`
	// beside it, named after it. The app wrote the `Vector`, which is listed.
	vectors := map[string]bool{}
	for _, s := range found {
		if s.Type == "sst:aws:Vector" {
			vectors[s.Name] = true
		}
	}
	named := map[string]int{}
	listed := []Stranded{}
	for _, s := range found {
		if s.Type == "sst:aws:Postgres" && vectors[strings.TrimSuffix(s.Name, "Database")] && strings.HasSuffix(s.Name, "Database") {
			continue
		}
		listed = append(listed, s)
		named[s.Name]++
	}
	for i := range listed {
		if named[listed[i].Name] < 2 {
			listed[i].In = ""
		}
	}
	found = listed
	if len(found) == 0 {
		return nil
	}
	sort.Slice(found, func(i, j int) bool {
		if found[i].Name != found[j].Name {
			return found[i].Name < found[j].Name
		}
		return found[i].In < found[j].In
	})
	return found
}

// Whether a resource is inside one of SST's components
func insideSST(res apitype.ResourceV3) bool {
	chain := strings.Split(string(res.URN.QualifiedType()), "$")
	for _, parent := range chain[:len(chain)-1] {
		if strings.HasPrefix(parent, "sst:") {
			return true
		}
	}
	return false
}
