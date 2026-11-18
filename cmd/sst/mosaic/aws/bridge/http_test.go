package bridge

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestHead(t *testing.T) {
	var buf bytes.Buffer
	head := HttpRequestHead{
		FunctionID: "Api",
		Method:     "POST",
		URI:        "/a?b=1",
		Host:       "example.on.aws",
		// a value with a newline can't break the line the head is
		Header: http.Header{"X-Test": {"one\ntwo"}},
	}
	if err := WriteHead(&buf, head); err != nil {
		t.Fatal(err)
	}
	buf.WriteString("body\nwith lines")
	var got HttpRequestHead
	rest, err := ReadHead(&buf, &got)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(rest)
	if got.URI != head.URI || got.Header.Get("X-Test") != "one\ntwo" || string(body) != "body\nwith lines" {
		t.Fatalf("got %+v and %q", got, body)
	}
}

func TestHeadTooLong(t *testing.T) {
	long := strings.NewReader(strings.Repeat("x", maxHead+10))
	var got HttpRequestHead
	if _, err := ReadHead(long, &got); !errors.Is(err, ErrHeadTooLong) {
		t.Fatalf("got %v, want ErrHeadTooLong", err)
	}
}
