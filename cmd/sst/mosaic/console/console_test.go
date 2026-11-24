package console

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"
	"unicode/utf8"

	"github.com/sst/sst/v3/pkg/bus"
)

// fake is a module that counts the events it's sent and emits each one.
type fake struct {
	name     string
	requires []string
	started  *int
}

type ping struct{ N int }

func (f fake) Name() string  { return f.name }
func (f fake) Title() string { return strings.ToUpper(f.name) }
func (f fake) Web() fs.FS {
	return fstest.MapFS{f.name + ".js": {Data: []byte("SST.register({name:'" + f.name + "'})")}}
}
func (f fake) Requires() []string { return f.requires }
func (f fake) Start(ctx context.Context, c *Console) error {
	if f.started != nil {
		*f.started++
	}
	seen := []int{}
	c.On(&ping{}, func(evt any) {
		n := evt.(*ping).N
		seen = append(seen, n)
		c.Emit(f.name, "ping", n)
	})
	c.Snapshot(f.name, func() []Message {
		return []Message{c.Message(f.name, "seen", seen)}
	})
	return nil
}

func available() []Module {
	return []Module{fake{name: "logs"}, fake{name: "invocations", requires: []string{"logs"}}, fake{name: "deploy"}}
}

func TestParse(t *testing.T) {
	cases := []struct {
		flag, env string
		want      []string
		err       string
	}{
		{"", "", nil, ""},
		{"off", "", nil, ""},
		{"false", "logs", nil, ""},
		{"0", "", nil, ""},
		{"all", "", []string{"logs", "invocations", "deploy"}, ""},
		{"true", "", []string{"logs", "invocations", "deploy"}, ""},
		{"", "1", []string{"logs", "invocations", "deploy"}, ""},
		{"deploy", "", []string{"deploy"}, ""},
		// in the order of the tabs, whatever the order asked for
		{"deploy, logs", "", []string{"logs", "deploy"}, ""},
		{"", "deploy", []string{"deploy"}, ""},
		// the flag takes the environment's place
		{"logs", "deploy", []string{"logs"}, ""},
		// what a module needs comes with it
		{"invocations", "", []string{"logs", "invocations"}, ""},
		{"LOGS", "", []string{"logs"}, ""},
		{"logs,nope", "", nil, `there's no console module "nope": the modules are logs, invocations, deploy`},
		// a value that names no module is a mistake, not off
		{",", "", nil, `"," lists no console modules: the modules are logs, invocations, deploy, or give off for none`},
		{"", " , ", nil, `"," lists no console modules: the modules are logs, invocations, deploy, or give off for none`},
	}
	for _, tc := range cases {
		got, err := Parse(tc.flag, tc.env, available())
		if tc.err != "" {
			if err == nil || err.Error() != tc.err {
				t.Errorf("Parse(%q, %q): error %v, want %q", tc.flag, tc.env, err, tc.err)
			}
			continue
		}
		if err != nil {
			t.Errorf("Parse(%q, %q): %v", tc.flag, tc.env, err)
			continue
		}
		if strings.Join(got, ",") != strings.Join(tc.want, ",") || (got == nil) != (tc.want == nil) {
			t.Errorf("Parse(%q, %q) = %#v, want %#v", tc.flag, tc.env, got, tc.want)
		}
	}
}

// Clip keeps a cut text, with what says it was cut, within max bytes, and
// valid UTF-8.
func TestClip(t *testing.T) {
	if got := Clip("short", 10); got != "short" {
		t.Fatalf("Clip cut %q", got)
	}
	long := strings.Repeat("é", 100)
	for _, max := range []int{0, 5, len(clipped), len(clipped) + 1, 50, 199} {
		got := Clip(long, max)
		if !strings.HasSuffix(got, clipped) || !utf8.ValidString(got) || (max >= len(clipped) && len(got) > max) {
			t.Errorf("Clip(%d) = %q, %d bytes", max, got, len(got))
		}
	}
}

// With the console off nothing of it starts: no module, no subscription to
// the bus, no listener.
func TestOffStartsNothing(t *testing.T) {
	started := 0
	before := len(bus.Stats())
	modules := []Module{fake{name: "logs", started: &started}}
	for _, value := range []string{"", "off", "false", "0"} {
		s, err := Configured(context.Background(), value, "", Config{Available: modules})
		if err != nil || s != nil {
			t.Fatalf("Configured(%q) = %v, %v; want nothing", value, s, err)
		}
	}
	if started != 0 {
		t.Fatalf("a module started %d times", started)
	}
	if after := len(bus.Stats()); after != before {
		t.Fatalf("bus subscribers went from %d to %d", before, after)
	}
}

func TestUnknownModuleIsAnError(t *testing.T) {
	s, err := Configured(context.Background(), "nope", "", Config{Available: available()})
	if err == nil || s != nil {
		t.Fatalf("Configured(nope) = %v, %v; want an error", s, err)
	}
}

// open starts a console with the modules, and gives its address and a client
// with its cookie.
func open(t *testing.T, modules ...string) (*Server, *http.Client, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	started := bus.Subscribe(&StartedEvent{})
	s, err := Configured(ctx, strings.Join(modules, ","), "", Config{Available: available(), App: "app", Stage: "stage"})
	if err != nil || s == nil {
		t.Fatalf("Configured: %v, %v", s, err)
	}
	select {
	case evt := <-started:
		if evt.(*StartedEvent).URL != s.URL() {
			t.Fatalf("published %q, but the link is %q", evt.(*StartedEvent).URL, s.URL())
		}
	case <-time.After(time.Second):
		t.Fatal("no StartedEvent")
	}
	bus.Unsubscribe(started)
	done := make(chan struct{})
	go func() {
		s.Serve(ctx)
		close(done)
	}()
	jar := &cookies{}
	client := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(s.URL())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusSeeOther {
		t.Fatalf("opening the link: %d", res.StatusCode)
	}
	return s, client, func() {
		cancel()
		<-done
	}
}

type cookies struct{ list []*http.Cookie }

func (c *cookies) SetCookies(u *url.URL, cookies []*http.Cookie) { c.list = append(c.list, cookies...) }
func (c *cookies) Cookies(u *url.URL) []*http.Cookie             { return c.list }

func base(s *Server) string {
	u, _ := url.Parse(s.URL())
	return "http://" + u.Host
}

func TestListensOnLoopbackOnly(t *testing.T) {
	s, _, stop := open(t, "logs")
	defer stop()
	host, _, err := net.SplitHostPort(s.listener.Addr().String())
	if err != nil || host != "127.0.0.1" {
		t.Fatalf("listening on %q", s.listener.Addr())
	}
}

func TestGate(t *testing.T) {
	g := &gate{port: 4321, token: "secret", next: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("in"))
	})}
	cookie := &http.Cookie{Name: "sst_console_4321", Value: "secret"}
	cases := []struct {
		name   string
		method string
		target string
		host   string
		cookie *http.Cookie
		header map[string]string
		want   int
	}{
		{name: "the cookie lets in", target: "/", host: "127.0.0.1:4321", cookie: cookie, want: 200},
		{name: "localhost is this host too", target: "/", host: "localhost:4321", cookie: cookie, want: 200},
		{name: "no cookie", target: "/", host: "127.0.0.1:4321", want: 401},
		{name: "another console's cookie", target: "/", host: "127.0.0.1:4321", cookie: &http.Cookie{Name: "sst_console_4321", Value: "other"}, want: 401},
		{name: "the cookie of another port", target: "/", host: "127.0.0.1:4321", cookie: &http.Cookie{Name: "sst_console_1234", Value: "secret"}, want: 401},
		{name: "DNS rebinding", target: "/", host: "evil.example:4321", cookie: cookie, want: 421},
		{name: "another port", target: "/", host: "127.0.0.1:80", cookie: cookie, want: 421},
		{name: "another interface's address", target: "/", host: "192.168.1.2:4321", cookie: cookie, want: 421},
		{name: "another site", target: "/events", host: "127.0.0.1:4321", cookie: cookie, header: map[string]string{"Sec-Fetch-Site": "cross-site"}, want: 403},
		{name: "a site on this machine", target: "/events", host: "127.0.0.1:4321", cookie: cookie, header: map[string]string{"Sec-Fetch-Site": "same-site"}, want: 403},
		{name: "its own page", target: "/events", host: "127.0.0.1:4321", cookie: cookie, header: map[string]string{"Sec-Fetch-Site": "same-origin"}, want: 200},
		{name: "a POST", method: "POST", target: "/", host: "127.0.0.1:4321", cookie: cookie, want: 405},
		{name: "a token from another run", target: "/?token=old", host: "127.0.0.1:4321", want: 403},
		{name: "the link", target: "/?token=secret", host: "127.0.0.1:4321", header: map[string]string{"Sec-Fetch-Site": "none"}, want: 303},
	}
	for _, tc := range cases {
		method := tc.method
		if method == "" {
			method = "GET"
		}
		r := httptest.NewRequest(method, tc.target, nil)
		r.Host = tc.host
		if tc.cookie != nil {
			r.AddCookie(tc.cookie)
		}
		for k, v := range tc.header {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, w.Code, tc.want)
		}
		if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") || !strings.Contains(csp, "frame-ancestors 'none'") {
			t.Errorf("%s: Content-Security-Policy %q", tc.name, csp)
		}
		if w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: no nosniff", tc.name)
		}
		if tc.want == 303 {
			c := w.Result().Cookies()
			if len(c) != 1 || c[0].Name != "sst_console_4321" || c[0].Value != "secret" || !c[0].HttpOnly || c[0].SameSite != http.SameSiteStrictMode {
				t.Errorf("%s: cookie %+v", tc.name, c)
			}
			if loc := w.Header().Get("Location"); loc != "/" {
				t.Errorf("%s: redirected to %q, which should drop the token", tc.name, loc)
			}
		}
	}
}

// read reads the stream's messages until it has n.
func read(t *testing.T, r *bufio.Reader, n int) []Message {
	t.Helper()
	out := []Message{}
	for len(out) < n {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("reading the stream after %d messages: %v", len(out), err)
		}
		data, ok := strings.CutPrefix(strings.TrimRight(line, "\n"), "data: ")
		if !ok {
			continue
		}
		var m Message
		if err := json.Unmarshal([]byte(data), &m); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

func stream(t *testing.T, s *Server, client *http.Client, query string) (*bufio.Reader, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", base(s)+"/events"+query, nil)
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("/events: %d %s", res.StatusCode, b)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type %q", ct)
	}
	return bufio.NewReader(res.Body), func() {
		cancel()
		res.Body.Close()
	}
}

// A page gets the snapshot, then every event after it, and none twice.
func TestSnapshotThenLive(t *testing.T) {
	s, client, stop := open(t, "logs", "deploy")
	defer stop()
	bus.Publish(&ping{N: 1})
	bus.Publish(&ping{N: 2})
	// the events are handled before the page connects
	waitFor(t, s, func() bool { return s.console.seq >= 4 })
	r, done := stream(t, s, client, "?modules=logs")
	defer done()
	got := read(t, r, 4)
	if got[0].Type != "hello" || got[1].Type != "status" || got[3].Type != "ready" {
		t.Fatalf("snapshot %+v", got)
	}
	if got[2].Module != "logs" || got[2].Type != "seen" {
		t.Fatalf("snapshot of logs %+v", got[2])
	}
	if b, _ := json.Marshal(got[2].Data); string(b) != "[1,2]" {
		t.Fatalf("snapshot has %s, want [1,2]", b)
	}
	var info hello
	Decode(got[0], &info)
	if info.App != "app" || info.Stage != "stage" || len(info.Modules) != 1 || info.Modules[0].Name != "logs" {
		t.Fatalf("hello %+v", info)
	}
	bus.Publish(&ping{N: 3})
	live := read(t, r, 1)[0]
	// deploy's messages aren't this page's
	if live.Module != "logs" || live.Type != "ping" || live.Data.(float64) != 3 || live.Seq <= got[2].Seq {
		t.Fatalf("live %+v", live)
	}
}

func TestStreamOfAModuleThatsOff(t *testing.T) {
	s, client, stop := open(t, "deploy")
	defer stop()
	res, err := client.Get(base(s) + "/events?modules=logs")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("%d", res.StatusCode)
	}
}

// A page that stops reading is cut off, to connect again for a snapshot, and
// the console, and so the bus, carries on.
func TestSlowPageIsMadeToResync(t *testing.T) {
	c, err := New(context.Background(), Config{Available: available(), Modules: []string{"logs"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	slow, _ := c.connect([]string{"logs"})
	fast, _ := c.connect([]string{"logs"})
	go func() {
		for range fast.ch {
		}
	}()
	for i := 0; i < clientBuffer+10; i++ {
		c.dispatch(&ping{N: i})
	}
	if !slow.closed || c.resyncs != 1 {
		t.Fatalf("slow page: closed %v, resyncs %d", slow.closed, c.resyncs)
	}
	if fast.closed {
		t.Fatal("the page that reads was cut off")
	}
	n := 0
	for range slow.ch {
		n++
	}
	if n != clientBuffer {
		t.Fatalf("the slow page got %d before it was cut off", n)
	}
	c.drop(slow)
	if len(c.clients) != 1 {
		t.Fatalf("%d pages", len(c.clients))
	}
}

// A module samples only while a page shows its tab.
func TestWatchedIsTheTabInView(t *testing.T) {
	s, client, stop := open(t, "logs", "deploy")
	defer stop()
	r, done := stream(t, s, client, "")
	defer done()
	var info hello
	console := read(t, r, 1)[0]
	Decode(console, &info)
	watched := func(module string) bool {
		ok := false
		s.console.Do(context.Background(), func() { ok = s.console.Watched(module) })
		return ok
	}
	if watched("logs") || watched("deploy") {
		t.Fatal("watched before a tab was shown")
	}
	get := func(query string) int {
		res, err := client.Get(base(s) + "/shown?" + query)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if code := get(fmt.Sprintf("page=%d&module=deploy", info.Page)); code != 204 {
		t.Fatalf("/shown: %d", code)
	}
	if !watched("deploy") || watched("logs") {
		t.Fatal("deploy's tab is shown")
	}
	// out of view
	get(fmt.Sprintf("page=%d&module=", info.Page))
	if watched("deploy") {
		t.Fatal("the page is out of view")
	}
	if code := get("page=999&module=deploy"); code != 404 {
		t.Fatalf("another page: %d", code)
	}
	if code := get("page=x"); code != 400 {
		t.Fatalf("no page: %d", code)
	}
}

// Once the dispatcher has a call, Do waits for it, though its request ends:
// a page that's closed as it connects isn't left behind.
func TestDoWaitsForWhatTheDispatcherHas(t *testing.T) {
	c, err := New(context.Background(), Config{Available: available(), Modules: []string{"logs"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	ctx, cancel := context.WithCancel(context.Background())
	ran := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- c.Do(ctx, func() {
			cancel()
			// the request has ended while fn runs
			time.Sleep(20 * time.Millisecond)
			close(ran)
		})
	}()
	fn := <-c.calls
	fn()
	if err := <-result; err != nil {
		t.Fatalf("Do returned %v once fn ran", err)
	}
	<-ran
}

// Without a page open, nothing is marshalled.
func TestEmitWithoutPagesMarshalsNothing(t *testing.T) {
	c, err := New(context.Background(), Config{Available: available(), Modules: []string{"logs"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	allocs := testing.AllocsPerRun(100, func() { c.Emit("logs", "ping", 1) })
	if allocs > 0 {
		t.Fatalf("Emit with no page allocates %v times", allocs)
	}
}

func TestPageLoadsTheModulesThatAreOn(t *testing.T) {
	s, client, stop := open(t, "deploy")
	defer stop()
	res, err := client.Get(base(s) + "/")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	page := string(b)
	if !strings.Contains(page, `<script defer src="/modules/deploy/deploy.js">`) || strings.Contains(page, "/modules/logs/") {
		t.Fatalf("page:\n%s", page)
	}
	for _, path := range []string{"/assets/console.js", "/assets/console.css", "/modules/deploy/deploy.js"} {
		res, err := client.Get(base(s) + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Errorf("%s: %d", path, res.StatusCode)
		}
	}
	for _, path := range []string{"/assets/", "/modules/deploy/", "/modules/logs/logs.js"} {
		res, err := client.Get(base(s) + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 404 {
			t.Errorf("%s: %d, want 404", path, res.StatusCode)
		}
	}
}

func waitFor(t *testing.T, s *Server, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		ok := false
		s.console.Do(context.Background(), func() { ok = cond() })
		if ok {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out")
}

func TestMisplaced(t *testing.T) {
	for _, tc := range []struct {
		flag string
		args []string
		bad  bool
	}{
		{"all", []string{"logs"}, true},
		{"all", []string{"logs,deploy"}, true},
		{"all", []string{"next", "dev"}, false},
		{"all", nil, false},
		{"logs", []string{"logs"}, false},
		{"", []string{"logs"}, false},
	} {
		if err := Misplaced(tc.flag, tc.args, available()); (err != nil) != tc.bad {
			t.Errorf("Misplaced(%q, %q) = %v", tc.flag, tc.args, err)
		}
	}
}

func TestWithCommand(t *testing.T) {
	for _, tc := range []struct {
		flag string
		args []string
		bad  bool
	}{
		{"all", []string{"next", "dev"}, true},
		{"logs", []string{"next", "dev"}, true},
		{"logs", nil, false},
		{"", []string{"next", "dev"}, false},
		{"off", []string{"next", "dev"}, false},
	} {
		if err := WithCommand(tc.flag, tc.args, available()); (err != nil) != tc.bad {
			t.Errorf("WithCommand(%q, %q) = %v", tc.flag, tc.args, err)
		}
	}
}
