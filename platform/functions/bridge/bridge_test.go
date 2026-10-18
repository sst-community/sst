package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPingTimeoutOf(t *testing.T) {
	cases := map[string]time.Duration{
		"":      defaultPingTimeout,
		"60000": time.Minute,
		"250":   250 * time.Millisecond,
		"0":     defaultPingTimeout,
		"-5":    defaultPingTimeout,
		"10s":   defaultPingTimeout,
	}
	for value, want := range cases {
		if got := pingTimeoutOf(value); got != want {
			t.Errorf("pingTimeoutOf(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestIsHTTPEvent(t *testing.T) {
	cases := map[string]bool{
		// API Gateway REST API, and its request authorizer
		`{"resource":"/hello","httpMethod":"GET","requestContext":{"stage":"dev"}}`: true,
		`{"type":"REQUEST","methodArn":"arn","requestContext":{"stage":"dev"}}`:     true,
		// HTTP API and function URL
		`{"version":"2.0","rawPath":"/","requestContext":{"http":{"method":"GET"}}}`: true,
		// load balancer
		`{"requestContext":{"elb":{"targetGroupArn":"arn"}},"httpMethod":"GET"}`: true,
		// event sources and direct invokes
		`{"Records":[{"eventSource":"aws:sqs","body":"x"}]}`: false,
		`{"source":"my.app","detail-type":"x","detail":{}}`:  false,
		`{"requestContext":null}`:                            false,
		`{}`:                                                 false,
		`"just a string"`:                                    false,
		`not json`:                                           false,
		``:                                                   false,
	}
	for event, want := range cases {
		if got := isHTTPEvent([]byte(event)); got != want {
			t.Errorf("isHTTPEvent(%s) = %v, want %v", event, got, want)
		}
	}
}

type answer struct {
	path, errorType string
	body            map[string]any
}

// runtimeAPI stands in for Lambda's runtime API, and passes on what's posted to it.
func runtimeAPI(t *testing.T) chan answer {
	t.Helper()
	got := make(chan answer, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		a := answer{path: r.Method + " " + r.URL.Path, errorType: r.Header.Get("Lambda-Runtime-Function-Error-Type")}
		if err := json.Unmarshal(raw, &a.body); err != nil {
			t.Errorf("body %q isn't JSON: %v", raw, err)
		}
		got <- a
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(srv.Close)
	api := LAMBDA_RUNTIME_API
	LAMBDA_RUNTIME_API = strings.TrimPrefix(srv.URL, "http://")
	t.Cleanup(func() { LAMBDA_RUNTIME_API = api })
	return got
}

// An event that isn't an HTTP request fails with an error, so a direct invoke
// fails and an event source retries it.
func TestUnavailableFailsAnEvent(t *testing.T) {
	got := runtimeAPI(t)
	unavailable("req-1", []byte(`{"Records":[{"eventSource":"aws:sqs"}]}`), "sst dev didn't answer")

	a := <-got
	if want := "POST /2018-06-01/runtime/invocation/req-1/error"; a.path != want {
		t.Errorf("posted to %q, want %q", a.path, want)
	}
	if a.errorType != unavailableErrorType {
		t.Errorf("error type header %q, want %q", a.errorType, unavailableErrorType)
	}
	if a.body["errorType"] != unavailableErrorType || a.body["errorMessage"] != "sst dev didn't answer" {
		t.Errorf("body %v, want the error type and message", a.body)
	}
}

// An HTTP request gets a response its caller shows, with a status that's a
// number, as API Gateway, function URLs and load balancers all read one.
func TestUnavailableAnswersAnHTTPRequest(t *testing.T) {
	got := runtimeAPI(t)
	unavailable("req-2", []byte(`{"version":"2.0","requestContext":{"http":{"method":"GET"}}}`), "sst dev didn't answer")

	a := <-got
	if want := "POST /2018-06-01/runtime/invocation/req-2/response"; a.path != want {
		t.Errorf("posted to %q, want %q", a.path, want)
	}
	if a.errorType != "" {
		t.Errorf("a response has the error type header %q", a.errorType)
	}
	if a.body["statusCode"] != float64(500) || a.body["body"] != "sst dev didn't answer" {
		t.Errorf("body %v, want a 500 with the message", a.body)
	}
}
