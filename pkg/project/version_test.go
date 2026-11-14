package project

import "testing"

func TestVersionAllowed(t *testing.T) {
	cases := []struct {
		rule    string
		cli     string
		allowed bool
	}{
		{">= 4", "4.20.0", true},
		{">= 4", "3.9.0", false},
		// A pre-release meets a rule its release meets
		{">= 4", "5.0.0-alpha.1", true},
		{"5.x", "5.0.0-alpha.1", true},
		{"*", "5.0.0-alpha.1", true},
		{">= 5.0.0-0", "5.0.0-alpha.1", true},
		// and no other
		{"4.x", "5.0.0-alpha.1", false},
		{"< 5", "5.0.0-alpha.1", false},
		{"^4.20.0", "5.0.0-alpha.1", false},
	}
	for _, c := range cases {
		allowed, err := versionAllowed(c.rule, c.cli)
		if err != nil {
			t.Fatalf("%q with %s: %v", c.rule, c.cli, err)
		}
		if allowed != c.allowed {
			t.Errorf("%q with %s: got %v, want %v", c.rule, c.cli, allowed, c.allowed)
		}
	}
}

func TestVersionAllowedInvalid(t *testing.T) {
	if _, err := versionAllowed("not a rule", "5.0.0"); err != ErrVersionInvalid {
		t.Errorf("an invalid rule: got %v", err)
	}
	if _, err := versionAllowed(">= 4", "not a version"); err != ErrVersionInvalid {
		t.Errorf("an invalid version: got %v", err)
	}
}
