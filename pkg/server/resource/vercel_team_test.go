package resource

import "testing"

// A Vercel team, as Pulumi's Vercel provider takes it: its ID or its slug
func TestTeamQuery(t *testing.T) {
	for team, want := range map[string]string{
		"team_abc123":  "teamId=team_abc123",
		"my-team":      "slug=my-team",
		"my team&more": "slug=my+team%26more",
	} {
		if got := teamQuery(team); got != want {
			t.Errorf("teamQuery(%q) = %q, want %q", team, got, want)
		}
	}
}
