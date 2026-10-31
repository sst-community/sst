package main

import "testing"

func TestFlociSessionEndpoint(t *testing.T) {
	for _, endpoint := range []string{"http://127.0.0.1:4567", "http://127.0.0.1:4567/"} {
		if got := flociSessionEndpoint(endpoint); got != "http://127.0.0.1:4567" {
			t.Fatal(got)
		}
	}
	if flociSessionEndpoint("") != "http://127.0.0.1:4566" {
		t.Fatal("incorrect default")
	}
	if flociSessionEndpoint("http://127.0.0.1:4567/") == flociSessionEndpoint("http://127.0.0.1:4568/") {
		t.Fatal("distinct instances conflated")
	}
}
