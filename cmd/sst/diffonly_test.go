package main

import (
	"testing"

	"github.com/sst/sst/v3/cmd/sst/cli"
)

func TestCheckDiffOnly(t *testing.T) {
	path := func(names ...string) cli.CommandPath {
		p := cli.CommandPath{{Name: "sst"}}
		for _, name := range names {
			p = append(p, cli.Command{Name: name})
		}
		return p
	}
	for _, allowed := range []cli.CommandPath{path(), path("diff"), path("version")} {
		if err := checkDiffOnly(allowed, false); err != nil {
			t.Errorf("expected %v to run, got %v", allowed, err)
		}
	}
	for _, name := range []string{"deploy", "remove", "refresh", "dev", "unlock", "secret", "state", "install", "upgrade"} {
		if err := checkDiffOnly(path(name), false); err == nil {
			t.Errorf("expected sst %s to be refused", name)
		}
		if err := checkDiffOnly(path(name), true); err != nil {
			t.Errorf("expected help for sst %s to be shown, got %v", name, err)
		}
	}
	if err := checkDiffOnly(path("secret", "set"), false); err == nil {
		t.Errorf("expected sst secret set to be refused")
	}
}
