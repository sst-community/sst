package project

import "testing"

func TestNodeTooOld(t *testing.T) {
	cases := map[string]bool{
		"18.20.4":  true,
		"20.19.0":  true,
		"v20.19.0": true,
		"22.0.0":   false,
		"22.12.0":  false,
		"24.13.0":  false,
		"":         false,
		"unknown":  false,
	}
	for version, want := range cases {
		if got := NodeTooOld(version); got != want {
			t.Errorf("NodeTooOld(%q) = %v, want %v", version, got, want)
		}
	}
}
