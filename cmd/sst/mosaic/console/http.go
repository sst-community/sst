package console

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/sst/sst/v3/pkg/bus"
)

//go:embed web
var web embed.FS

var page = template.Must(template.ParseFS(web, "web/index.html"))

// The page loads nothing but its own files, and nothing can frame it. Logs
// and payloads are shown as text, never as markup, so a log line can't run in
// the page; this is what stops one if a module gets that wrong.
const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; " +
	"img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// how often a stream that's quiet is written to, so a proxy or the browser
// doesn't take it for dead
const heartbeat = 15 * time.Second

// Open starts the console with the configured modules: it subscribes to the
// bus now, so it sees the first deploy, and listens on loopback, on a port
// that's free. It publishes the link to open it in a StartedEvent. Serve runs
// it. It never stops sst dev: when it can't start, it says why in the CLI's
// log, and returns nil.
//
// What it shows has secrets in it (function inputs, outputs and logs), so it
// only lets in the browser that opened its link:
//
//   - It listens on 127.0.0.1 only, so other machines can't reach it, and not
//     on the dev server, which listens on every interface.
//   - The link carries a token that's new each run. Opening it sets a cookie
//     that only this port's console takes, and every request needs it.
//   - A request for another host, as from a page that points its own name at
//     this machine (DNS rebinding), is refused, and so is one another site
//     makes (Sec-Fetch-Site, or Origin where a browser doesn't send that).
//     The cookie is SameSite=Strict, so another site can't send it either.
//   - It only serves GET: nothing on the page changes sst dev, beyond which
//     tab it shows, so a module samples only while its tab is open.
//
// What it can't keep out is a program on this machine that reads the link
// from the terminal or the CLI's log.
func Open(ctx context.Context, cfg Config) *Server {
	log := slog.Default().With("service", "console")
	c, err := New(ctx, cfg)
	if err != nil {
		log.Error("not starting", "err", err)
		return nil
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		c.close()
		log.Error("not starting: can't listen", "err", err)
		return nil
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		c.close()
		listener.Close()
		log.Error("not starting: no token", "err", err)
		return nil
	}
	port := listener.Addr().(*net.TCPAddr).Port
	g := &gate{port: port, token: hex.EncodeToString(token), next: c.mux}
	log.Info("listening", "addr", listener.Addr(), "modules", cfg.Modules)
	s := &Server{console: c, listener: listener, gate: g}
	bus.Publish(&StartedEvent{URL: g.link()})
	return s
}

// Configured opens the console with the modules --console's value (flag) or
// SST_CONSOLE's (env) turn on. When neither turns any on, nothing starts:
// there's no listener, no subscription to the bus and no sampling, and it
// returns nil. It returns an error only for a value that names no module.
func Configured(ctx context.Context, flag, env string, cfg Config) (*Server, error) {
	modules, err := Parse(flag, env, cfg.Available)
	if err != nil || modules == nil {
		return nil, err
	}
	cfg.Modules = modules
	return Open(ctx, cfg), nil
}

// Server is a console that's listening.
type Server struct {
	console  *Console
	listener net.Listener
	gate     *gate
}

// URL is the link to open the console, with its token.
func (s *Server) URL() string {
	return s.gate.link()
}

// Serve serves the console until ctx ends.
func (s *Server) Serve(ctx context.Context) {
	server := &http.Server{
		Handler:           s.gate,
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          slog.NewLogLogger(slog.Default().Handler(), slog.LevelInfo),
	}
	go func() {
		<-ctx.Done()
		server.Close()
	}()
	go server.Serve(s.listener)
	s.console.Run(ctx)
}

// gate lets in only the browser that opened the console's link, for this
// host. See Start.
type gate struct {
	port  int
	token string
	next  http.Handler
}

func (g *gate) link() string {
	return fmt.Sprintf("http://127.0.0.1:%d/?token=%s", g.port, g.token)
}

// cookie is named for the port, as a browser sends a host's cookies to each
// of its ports, and two sst devs each have a console.
func (g *gate) cookie() string {
	return "sst_console_" + strconv.Itoa(g.port)
}

func (g *gate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Security-Policy", contentSecurityPolicy)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Cache-Control", "no-store")
	if !g.host(r.Host) {
		http.Error(w, "This isn't the host of sst dev's console.", http.StatusMisdirectedRequest)
		return
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
	default:
		http.Error(w, "The console doesn't take requests from other sites.", http.StatusForbidden)
		return
	}
	// for a browser that doesn't send Sec-Fetch-Site: a page on another port
	// of this host is the same site, so the cookie alone doesn't keep it out
	if origin := r.Header.Get("Origin"); origin != "" && !g.host(strings.TrimPrefix(origin, "http://")) {
		http.Error(w, "The console doesn't take requests from other sites.", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "The console only reads.", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/" && r.URL.Query().Has("token") {
		if !equal(r.URL.Query().Get("token"), g.token) {
			http.Error(w, "This link is from another run of sst dev. Open the one it printed last.", http.StatusForbidden)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     g.cookie(),
			Value:    g.token,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})
		// the token leaves the address bar and the history
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	cookie, err := r.Cookie(g.cookie())
	if err != nil || !equal(cookie.Value, g.token) {
		http.Error(w, "Open the console with the link sst dev printed.", http.StatusUnauthorized)
		return
	}
	g.next.ServeHTTP(w, r)
}

// host is whether a request's Host is this console's: 127.0.0.1 or localhost,
// at its port.
func (g *gate) host(host string) bool {
	port := ":" + strconv.Itoa(g.port)
	return host == "127.0.0.1"+port || host == "localhost"+port
}

func equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (c *Console) routes() {
	c.mux.HandleFunc("GET /{$}", c.servePage)
	c.mux.Handle("GET /assets/", http.StripPrefix("/assets/", files(must(fs.Sub(web, "web/assets")))))
	for _, m := range c.modules {
		if m.Web() == nil {
			continue
		}
		prefix := "/modules/" + m.Name() + "/"
		c.mux.Handle("GET "+prefix, http.StripPrefix(prefix, files(m.Web())))
	}
	c.mux.HandleFunc("GET /events", c.serveEvents)
	c.mux.HandleFunc("GET /shown", c.serveShown)
}

// serveShown records which module's tab a page shows, as
// ?page=<its stream's ID>&module=<name>, or none with no module, so the
// modules that sample only do it while their tab is in view.
func (c *Console) serveShown(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseUint(r.URL.Query().Get("page"), 10, 64)
	if err != nil {
		http.Error(w, "page is a stream's ID", http.StatusBadRequest)
		return
	}
	module := r.URL.Query().Get("module")
	found := false
	if err := c.Do(r.Context(), func() { found = c.show(id, module) }); err != nil {
		return
	}
	if !found {
		http.Error(w, "no such page", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// files serves the files of fsys, and not its folders' listings.
func files(fsys fs.FS) http.Handler {
	server := http.FileServerFS(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if info, err := fs.Stat(fsys, name); err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		server.ServeHTTP(w, r)
	})
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

type pageModule struct {
	Name   string
	Title  string
	Script string
	Style  string
}

func (c *Console) servePage(w http.ResponseWriter, r *http.Request) {
	modules := []pageModule{}
	for _, m := range c.modules {
		files := m.Web()
		if files == nil {
			continue
		}
		pm := pageModule{Name: m.Name(), Title: m.Title()}
		if _, err := fs.Stat(files, m.Name()+".js"); err == nil {
			pm.Script = "/modules/" + m.Name() + "/" + m.Name() + ".js"
		}
		if _, err := fs.Stat(files, m.Name()+".css"); err == nil {
			pm.Style = "/modules/" + m.Name() + "/" + m.Name() + ".css"
		}
		modules = append(modules, pm)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := page.Execute(w, map[string]any{"Modules": modules, "App": c.cfg.App, "Stage": c.cfg.Stage}); err != nil {
		slog.Error("console: page", "err", err)
	}
}

// serveEvents streams the modules' messages as server-sent events: the
// snapshot, then everything after it. ?modules=a,b picks some of the modules
// that are on; without it, it's all of them.
func (c *Console) serveEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming isn't supported", http.StatusInternalServerError)
		return
	}
	modules := []string{}
	if q := r.URL.Query().Get("modules"); q != "" {
		for _, name := range strings.Split(q, ",") {
			name = strings.TrimSpace(name)
			if !c.enabled[name] {
				http.Error(w, fmt.Sprintf("module %q isn't on", name), http.StatusBadRequest)
				return
			}
			modules = append(modules, name)
		}
	} else {
		for _, m := range c.modules {
			modules = append(modules, m.Name())
		}
	}
	ctx := r.Context()
	var cl *client
	var snapshot [][]byte
	if err := c.Do(ctx, func() { cl, snapshot = c.connect(modules) }); err != nil || cl == nil {
		return
	}
	defer func() {
		// with sst dev's context, not the request's, which has ended
		c.Do(context.Background(), func() { c.drop(cl) })
	}()
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	out := bufio.NewWriterSize(w, 64<<10)
	write := func(b []byte) {
		out.WriteString("data: ")
		out.Write(b)
		out.WriteString("\n\n")
	}
	for _, b := range snapshot {
		write(b)
	}
	out.Flush()
	flusher.Flush()
	snapshot = nil
	ping := time.NewTicker(heartbeat)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			out.WriteString(": ping\n\n")
		case b, ok := <-cl.ch:
			if !ok {
				// too far behind: the page connects again for a snapshot
				return
			}
			write(b)
			// what's waiting goes in the same write
			for n := len(cl.ch); n > 0; n-- {
				b, ok := <-cl.ch
				if !ok {
					break
				}
				write(b)
			}
		}
		if err := out.Flush(); err != nil {
			return
		}
		flusher.Flush()
	}
}
