package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/pulumi/pulumi/pkg/v3/resource/stack"
	"github.com/pulumi/pulumi/sdk/v3/go/common/encoding"
)

// The states 4.x wrote for real apps (testdata/states), read through each
// home the way the core reads them.

func recordedStates(t *testing.T) []string {
	files, err := filepath.Glob(filepath.Join("..", "..", "..", "testdata", "states", "*", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no recorded states found")
	}
	return files
}

func TestRecordedStatesReadThroughEveryHome(t *testing.T) {
	for _, file := range recordedStates(t) {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		checkpoint, _, _, err := stack.UnmarshalVersionedCheckpointToLatestCheckpoint(encoding.JSON, data)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if checkpoint.Latest == nil || len(checkpoint.Latest.Resources) == 0 {
			t.Fatalf("%s: no resources", file)
		}
		// The stack is organization/<app>/<stage>.
		parts := strings.Split(string(checkpoint.Stack), "/")
		app, stage := parts[len(parts)-2], parts[len(parts)-1]

		// Laid out as 4.x left it in a local home: the file, at its path.
		root := t.TempDir()
		path := filepath.Join(root, "state", "app", app, stage+".json")
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0644); err != nil {
			t.Fatal(err)
		}
		local := &LocalHome{root: root}
		out := filepath.Join(t.TempDir(), "state.json")
		if err := PullState(local, app, stage, out); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if got, _ := os.ReadFile(out); string(got) != string(data) {
			t.Fatalf("%s: the state read isn't the state 4.x wrote", file)
		}
		stages, err := ListStages(local, app)
		if err != nil || len(stages) != 1 || stages[0] != stage {
			t.Fatalf("%s: expected [%s], got %v, %v", file, stage, stages, err)
		}

		// Written by the new core and read back, through a home that keeps
		// versions.
		memory := newMemoryHome()
		if err := PushPartialState(memory, "id", app, stage, data); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if got, _ := memory.Get(context.Background(), Key{Kind: "app", App: app, Stage: stage}); string(got) != string(data) {
			t.Fatalf("%s: the state changed in the round trip", file)
		}
	}
}

// Nothing private is committed: each recorded state was scrubbed.
func TestRecordedStatesAreScrubbed(t *testing.T) {
	accounts := []*regexp.Regexp{
		regexp.MustCompile(`arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:([0-9]{12}):`),
		regexp.MustCompile(`sqs\.[a-z0-9-]+\.amazonaws\.com/([0-9]{12})/`),
		regexp.MustCompile(`\b([0-9]{12})\.dkr\.ecr\.`),
		regexp.MustCompile(`"(?:accountId|ownerId|AWS:SourceOwner|aws:SourceAccount)":"?([0-9]{12})`),
	}
	// A Cloudflare account's id: in a field, in JSON or in JSON inside a
	// string, as a dynamic provider's code captured it, and in a path of
	// Cloudflare's API
	cloudflareAccounts := []*regexp.Regexp{
		regexp.MustCompile(`(?:accountId|account_id|DEFAULT_ACCOUNT_ID)\\?"?\s*[:=]\s*\\?"([0-9a-f]{32})\b`),
		regexp.MustCompile(`/accounts/([0-9a-f]{32})\b`),
	}
	// The account's workers.dev subdomain, in a Worker's URL
	workersDev := regexp.MustCompile(`\b([a-z0-9-]+)\.workers\.dev\b`)
	homes := regexp.MustCompile(`(/home/[^/"]+|/Users/[^/"]+)`)
	private := map[string]*regexp.Regexp{
		"an AWS access key":          regexp.MustCompile(`\b(AKIA|ASIA)[A-Z0-9]{16}\b`),
		"a macOS temp folder":        regexp.MustCompile(`/var/folders/`),
		"a secret's ciphertext":      regexp.MustCompile(`"ciphertext": ?"v1:(?:[^s]|s[^c])`),
		"a passphrase or AWS secret": regexp.MustCompile(`PULUMI_CONFIG_PASSPHRASE|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|SST_SECRET_`),
	}
	for _, file := range recordedStates(t) {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		for _, pattern := range accounts {
			for _, match := range pattern.FindAllStringSubmatch(text, -1) {
				if match[1] != "123456789012" {
					t.Fatalf("%s holds the account id %s", file, match[1])
				}
			}
		}
		for _, pattern := range cloudflareAccounts {
			for _, match := range pattern.FindAllStringSubmatch(text, -1) {
				if match[1] != "0123456789abcdef0123456789abcdef" {
					t.Fatalf("%s holds the Cloudflare account id %s", file, match[1])
				}
			}
		}
		for _, match := range workersDev.FindAllStringSubmatch(text, -1) {
			if match[1] != "example" {
				t.Fatalf("%s holds the workers.dev subdomain %s", file, match[1])
			}
		}
		for _, home := range homes.FindAllString(text, -1) {
			if home != "/home/user" {
				t.Fatalf("%s holds the home directory %s", file, home)
			}
		}
		for what, pattern := range private {
			if found := pattern.FindString(text); found != "" {
				t.Fatalf("%s holds %s: %q", file, what, found)
			}
		}
		// Every record is in the placeholder zone, not the lab's.
		var state struct {
			Checkpoint struct {
				Latest struct {
					Resources []struct {
						Type   string                 `json:"type"`
						Inputs map[string]interface{} `json:"inputs"`
					} `json:"resources"`
				} `json:"latest"`
			} `json:"checkpoint"`
		}
		if err := json.Unmarshal(data, &state); err != nil {
			t.Fatal(err)
		}
		for _, resource := range state.Checkpoint.Latest.Resources {
			if resource.Type != "aws:route53/record:Record" {
				continue
			}
			if zone := resource.Inputs["zoneId"]; zone != "Z00000000000000EXAMPLE" {
				t.Fatalf("%s has a record in the zone %v", file, zone)
			}
		}
	}
}
