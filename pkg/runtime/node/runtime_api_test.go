package node

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sst/sst/v3/pkg/runtime"
)

// The handler each invocation runs. It waits before it answers, as a real
// one does, since a request that follows a pause is the one that was held.
const handlerTakes = 200 * time.Millisecond

// What a call to the runtime API may add to an invocation, on the same
// machine. On Node.js 26.7, fetch held each one for about 300 ms, so this
// leaves room for a busy machine and still catches that.
const runtimeAPIBudget = 150 * time.Millisecond

type answer struct {
	path    string
	body    string
	took    time.Duration
	chunked bool
	// the request's Content-Type and Content-Length
	contentType   string
	contentLength int64
}

// runInvocations runs the real Node.js worker with the given handler, hands it
// invocations one after another, and returns how each was answered and how long
// after it was handed over.
func runInvocations(t *testing.T, code string, invocations int) []answer {
	t.Helper()
	return runInvocationsWith(t, code, invocations, faults{})
}

// faults are what the stand-in runtime API does wrong.
type faults struct {
	// cutAnswers is how many of sst dev's first answers to the worker's
	// answers are cut off partway, as when sst dev stops mid-reply. Only the
	// answers it takes in count.
	cutAnswers int
	// dropNexts is how many of the worker's first requests for an invocation
	// have their connection closed without an answer, as a kept-alive one sst
	// dev closed while it was idle is
	dropNexts int
}

// runInvocationsWith is runInvocations, with the stand-in runtime API at fault.
func runInvocationsWith(t *testing.T, code string, invocations int, f faults) []answer {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node isn't installed")
	}
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	dist := filepath.Join(repo, "platform", "dist", "nodejs-runtime", "index.js")
	if _, err := os.Stat(dist); err != nil {
		t.Skip("build the platform first, with bun run build:platform: " + err.Error())
	}
	root := t.TempDir()
	platform := filepath.Join(root, ".sst", "platform", "dist", "nodejs-runtime")
	if err := os.MkdirAll(platform, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dist, filepath.Join(platform, "index.js")); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(root, "out")
	if err := os.MkdirAll(out, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "index.mjs"), []byte(code), 0644); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var handed time.Time
	served := 0
	answers := []answer{}
	done := make(chan struct{})
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/invocation/next") {
			if length := r.Header.Get("Content-Length"); length != "" {
				t.Errorf("the request for the next invocation had Content-Length %s, want none, as fetch sent", length)
			}
			mu.Lock()
			if f.dropNexts > 0 {
				f.dropNexts--
				mu.Unlock()
				conn, _, _ := w.(http.Hijacker).Hijack()
				conn.Close()
				return
			}
			if served == invocations {
				mu.Unlock()
				<-r.Context().Done()
				return
			}
			served++
			handed = time.Now()
			mu.Unlock()
			w.Header().Set("lambda-runtime-aws-request-id", "request")
			w.Header().Set("lambda-runtime-deadline-ms", "9999999999999")
			w.Header().Set("lambda-runtime-invoked-function-arn", "arn:aws:lambda:us-east-1:123456789012:function:fn")
			w.Header().Set("lambda-runtime-cognito-identity", `{"cognitoIdentityId":"id"}`)
			w.Header().Set("lambda-runtime-client-context", `{"custom":{"k":"v"}}`)
			w.Write([]byte(`{"n":1}`))
			return
		}
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		if f.cutAnswers > 0 {
			f.cutAnswers--
			mu.Unlock()
			conn, buf, _ := w.(http.Hijacker).Hijack()
			buf.WriteString("HTTP/1.1 202 Accepted\r\nContent-Length: 10\r\n\r\nabc")
			buf.Flush()
			conn.Close()
			return
		}
		answers = append(answers, answer{r.URL.Path, string(body), time.Since(handed), slices.Contains(r.TransferEncoding, "chunked"), r.Header.Get("Content-Type"), r.ContentLength})
		if len(answers) == invocations {
			close(done)
		}
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(api.Close)

	worker, err := New("dev").Run(t.Context(), &runtime.RunInput{
		CfgPath:  filepath.Join(root, "sst.config.ts"),
		Server:   api.Listener.Addr().(*net.TCPAddr).String(),
		WorkerID: "test",
		Build:    &runtime.BuildOutput{Out: out, Handler: "index.handler"},
		Env:      []string{"PATH=" + os.Getenv("PATH")},
	})
	if err != nil {
		t.Fatal(err)
	}
	w := worker.(*Worker)
	if w.cmd.Process == nil {
		t.Fatal("the worker didn't start: is node on the PATH?")
	}
	t.Cleanup(func() {
		if w.cmd.Process != nil {
			w.cmd.Process.Kill()
		}
	})
	go io.Copy(io.Discard, w.Logs())

	select {
	case <-done:
	case <-time.After(30 * time.Second):
		mu.Lock()
		answered := len(answers)
		mu.Unlock()
		t.Fatalf("the worker answered %d of %d invocations", answered, invocations)
	}
	mu.Lock()
	defer mu.Unlock()
	return answers
}

// A worker answers its runtime API calls without holding them. Node.js 26.7's
// fetch held a request on a kept-alive connection until a timer fired, which
// added about 300 ms to each invocation here.
func TestWorkerAnswersWithoutDelay(t *testing.T) {
	cases := map[string]struct {
		code string
		path string
		body string
	}{
		"response": {
			code: fmt.Sprintf(`export const handler = async () => {
				await new Promise((r) => setTimeout(r, %d));
				return { statusCode: 200, body: "ok" };
			};`, handlerTakes.Milliseconds()),
			path: "/2018-06-01/runtime/invocation/request/response",
			body: `{"statusCode":200,"body":"ok"}`,
		},
		"error": {
			code: fmt.Sprintf(`export const handler = async () => {
				await new Promise((r) => setTimeout(r, %d));
				throw new Error("it failed");
			};`, handlerTakes.Milliseconds()),
			path: "/2018-06-01/runtime/invocation/request/error",
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			extras := []time.Duration{}
			for i, a := range runInvocations(t, c.code, 5) {
				if a.path != c.path {
					t.Errorf("invocation %d was answered at %s, want %s", i, a.path, c.path)
				}
				if c.body != "" && a.body != c.body {
					t.Errorf("invocation %d was answered with %s, want %s", i, a.body, c.body)
				}
				if c.body == "" {
					var e struct{ ErrorMessage string }
					if json.Unmarshal([]byte(a.body), &e); e.ErrorMessage != "it failed" {
						t.Errorf("invocation %d's error was %s", i, a.body)
					}
				}
				if a.contentType != "application/json" || a.contentLength != int64(len(a.body)) {
					t.Errorf("invocation %d was answered with Content-Type %q and Content-Length %d for %d bytes", i, a.contentType, a.contentLength, len(a.body))
				}
				extras = append(extras, a.took-handlerTakes)
			}
			// the median, so one timer that fires late on a busy machine
			// doesn't fail it, where fetch held every call
			slices.Sort(extras)
			if median := extras[len(extras)/2]; median > runtimeAPIBudget {
				t.Errorf("invocations were answered a median %v after their handler finished, want under %v (all: %v)", median.Round(time.Millisecond), runtimeAPIBudget, extras)
			}
		})
	}
}

// A handler that fails to load is reported as an init error.
func TestWorkerReportsAnInitError(t *testing.T) {
	answers := runInvocations(t, `throw new Error("it failed to load");`, 1)
	if want := "/2018-06-01/runtime/init/error"; answers[0].path != want {
		t.Fatalf("the worker reported to %s, want %s", answers[0].path, want)
	}
	var e struct{ ErrorMessage string }
	if json.Unmarshal([]byte(answers[0].body), &e); e.ErrorMessage != "it failed to load" {
		t.Errorf("the init error was %s", answers[0].body)
	}
}

// A handler that returns nothing is answered with an empty body that says it's
// empty, as fetch sent it, not a chunked one.
func TestWorkerAnswersAHandlerThatReturnsNothing(t *testing.T) {
	a := runInvocations(t, `export const handler = async () => {};`, 1)[0]
	if a.path != "/2018-06-01/runtime/invocation/request/response" || a.body != "" || a.chunked || a.contentLength != 0 {
		t.Errorf("answered at %s with %q, chunked %v, Content-Length %d; want an empty response with a length", a.path, a.body, a.chunked, a.contentLength)
	}
	if a.contentType != "application/json" {
		t.Errorf("answered with Content-Type %q, want application/json, as fetch sent", a.contentType)
	}
}

// When sst dev's answer to the worker's response is cut off, the worker sends
// the response again, as it does when sending fails, instead of waiting on the
// rest of an answer that won't come.
func TestWorkerSendsAgainWhenItsAnswerIsCutOff(t *testing.T) {
	a := runInvocationsWith(t, `export const handler = async () => ({ ok: true });`, 1, faults{cutAnswers: 1})[0]
	if a.path != "/2018-06-01/runtime/invocation/request/response" || a.body != `{"ok":true}` {
		t.Errorf("answered at %s with %q, want the response sent again", a.path, a.body)
	}
}

// The worker hands the handler the invocation's event, and the context it
// reads from the runtime API's headers.
func TestWorkerPassesTheInvocationsContext(t *testing.T) {
	a := runInvocations(t, `export const handler = async (event, context) => ({
		event,
		requestID: context.awsRequestId,
		arn: context.invokedFunctionArn,
		remaining: context.getRemainingTimeInMillis() > 0,
		identity: context.identity,
		clientContext: context.clientContext,
	});`, 1)[0]
	want := `{"event":{"n":1},"requestID":"request","arn":"arn:aws:lambda:us-east-1:123456789012:function:fn","remaining":true,"identity":{"cognitoIdentityId":"id"},"clientContext":{"custom":{"k":"v"}}}`
	if a.body != want {
		t.Errorf("the handler got\n%s\nwant\n%s", a.body, want)
	}
}

// When the worker's request for an invocation fails on its connection, as on a
// kept-alive one sst dev has closed, it's sent again, instead of being reported
// as an error.
func TestWorkerAsksAgainWhenItsConnectionIsClosed(t *testing.T) {
	a := runInvocationsWith(t, `export const handler = async () => ({ ok: true });`, 1, faults{dropNexts: 1})[0]
	if a.path != "/2018-06-01/runtime/invocation/request/response" || a.body != `{"ok":true}` {
		t.Errorf("answered at %s with %q, want the invocation's response", a.path, a.body)
	}
}
