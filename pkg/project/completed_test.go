package project

import "testing"

func TestWebFunctionOf(t *testing.T) {
	fn, ok := webFunctionOf("Api", map[string]interface{}{
		"_hint":        "https://abc.lambda-web.ca-central-1.on.aws",
		"_webFunction": map[string]interface{}{"url": "http://localhost:3000"},
	})
	if !ok || fn.Name != "Api" || fn.URL != "http://localhost:3000" {
		t.Fatalf("got %+v, %v", fn, ok)
	}
	for _, outputs := range []map[string]interface{}{
		{"_hint": "http://localhost:3000"},
		{"_webFunction": map[string]interface{}{}},
		{"_webFunction": map[string]interface{}{"url": ""}},
		{"_webFunction": "http://localhost:3000"},
	} {
		if fn, ok := webFunctionOf("Api", outputs); ok {
			t.Errorf("%v: got %+v, want none", outputs, fn)
		}
	}
}
