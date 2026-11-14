package dev

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestInherit(t *testing.T) {
	environ := []string{"HOME=/home/me", "AWS_PROFILE=admin", "AWS_DEFAULT_PROFILE=admin", "AWS_REGION=us-west-2"}

	// an SST app's dev command keeps the CLI's environment as it is, the
	// profile too, even when it has a role's credentials
	var app EnvResponse
	if err := json.Unmarshal([]byte(`{"env": {"AWS_ACCESS_KEY_ID": "AKIA"}, "command": "npm run dev"}`), &app); err != nil {
		t.Fatal(err)
	}
	if got := app.Inherit(environ); !slices.Equal(got, environ) {
		t.Fatalf("got %v", got)
	}

	// one that runs with its role's credentials alone leaves the profile out
	var only EnvResponse
	if err := json.Unmarshal([]byte(`{"env": {"AWS_ACCESS_KEY_ID": "AKIA"}, "command": "node report.mjs", "awsOnly": true}`), &only); err != nil {
		t.Fatal(err)
	}
	if got := only.Inherit(environ); !slices.Equal(got, []string{"HOME=/home/me", "AWS_REGION=us-west-2"}) {
		t.Fatalf("got %v", got)
	}
	// and doesn't change what it was given
	if len(environ) != 4 {
		t.Fatalf("environ %v", environ)
	}
}
