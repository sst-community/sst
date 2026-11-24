package cli

import (
	"testing"

	flag "github.com/spf13/pflag"
)

func TestAfterDash(t *testing.T) {
	for _, tc := range []struct {
		at, total, n int
		want         bool
	}{
		// sst dev -- logs: flag.Args() is [dev logs], with -- after dev
		{1, 2, 1, true},
		// sst dev logs
		{-1, 2, 1, false},
		// sst dev logs -- --flag: the command came before --
		{2, 3, 2, false},
		// sst dev --: nothing after it
		{1, 1, 0, false},
	} {
		if got := afterDash(tc.at, tc.total, tc.n); got != tc.want {
			t.Errorf("afterDash(%d, %d, %d) = %v", tc.at, tc.total, tc.n, got)
		}
	}
}

// A flag's name is one flag for every command, so two definitions of it with
// different Bare values are refused, not one silently taking the other's.
func TestBareConflicts(t *testing.T) {
	root := &Command{Name: "x", Children: []*Command{
		{Name: "a", Flags: []Flag{{Name: "bare-conflict-test", Type: "string", Bare: "all"}}},
		{Name: "b", Flags: []Flag{{Name: "bare-conflict-test", Type: "string"}}},
	}}
	// a set of its own, so the test's flag isn't left in sst's
	saved := flag.CommandLine
	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	defer func() {
		flag.CommandLine = saved
		if recover() == nil {
			t.Fatal("init took two Bare values for one flag")
		}
	}()
	root.init(map[string]interface{}{})
}
