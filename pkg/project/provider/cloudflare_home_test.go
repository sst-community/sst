package provider

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"

	cloudflare "github.com/cloudflare/cloudflare-go"
)

// fakeR2 answers the part of Cloudflare's API the Cloudflare home uses: get,
// put, delete and list the objects of one bucket. failPuts makes that many
// PUTs fail with a 429 first, as Cloudflare does when it rate limits.
type fakeR2 struct {
	mu       sync.Mutex
	objects  map[string][]byte
	failPuts int
}

const fakeR2Prefix = "/accounts/acct/r2/buckets/sst-state/objects"

func (f *fakeR2) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !strings.HasPrefix(r.URL.Path, fakeR2Prefix) {
		http.NotFound(w, r)
		return
	}
	key := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, fakeR2Prefix), "/")
	switch {
	case r.Method == http.MethodGet && key == "":
		prefix := r.URL.Query().Get("prefix")
		type object struct {
			Key string `json:"key"`
		}
		result := []object{}
		for k := range f.objects {
			if strings.HasPrefix(k, prefix) {
				result = append(result, object{Key: k})
			}
		}
		sort.Slice(result, func(i, j int) bool { return result[i].Key < result[j].Key })
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":     true,
			"result":      result,
			"result_info": map[string]interface{}{"cursor": "", "is_truncated": false},
		})
	case r.Method == http.MethodGet:
		data, ok := f.objects[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"success":false,"errors":[{"code":10007,"message":"The specified key does not exist."}],"messages":[],"result":null}`))
			return
		}
		w.Write(data)
	case r.Method == http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		if f.failPuts > 0 {
			f.failPuts--
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"success":false,"errors":[{"code":10000,"message":"rate limited"}]}`))
			return
		}
		f.objects[key] = body
		w.Write([]byte(`{"success":true,"result":{}}`))
	case r.Method == http.MethodDelete:
		delete(f.objects, key)
		w.Write([]byte(`{"success":true,"result":{}}`))
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func newFakeCloudflareHome(t *testing.T, fake *fakeR2, compress bool) *CloudflareHome {
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	api, err := cloudflare.NewWithAPIToken("token", cloudflare.BaseURL(server.URL), cloudflare.UsingRetryPolicy(3, 0, 0), cloudflare.UsingRateLimit(10000))
	if err != nil {
		t.Fatal(err)
	}
	home := NewCloudflareHome(&CloudflareProvider{api: api, identifier: cloudflare.AccountIdentifier("acct")}, compress)
	home.bootstrap = &bootstrap{State: "sst-state"}
	return home
}

func TestCloudflareHomeSuite(t *testing.T) {
	t.Parallel()
	for _, compress := range []bool{false, true} {
		fake := &fakeR2{objects: map[string][]byte{}}
		home := newFakeCloudflareHome(t, fake, compress)
		t.Run(map[bool]string{false: "plain", true: "compressed"}[compress], func(t *testing.T) {
			runHomeSuite(t, func() Home { return home })
		})
	}
}

// The keys are the ones 4.x wrote: <kind>/<app>/<stage>, with no extension.
func TestCloudflareHomeKeys(t *testing.T) {
	t.Parallel()
	fake := &fakeR2{objects: map[string][]byte{}}
	home := newFakeCloudflareHome(t, fake, false)
	update, err := Lock(home, "test", "deploy", "app", "dev")
	if err != nil {
		t.Fatal(err)
	}
	if err := PushPartialState(home, update.ID, "app", "dev", checkpoint("app", "dev", 1)); err != nil {
		t.Fatal(err)
	}
	if err := PutSecrets(home, "app", "dev", map[string]string{"A": "b"}); err != nil {
		t.Fatal(err)
	}
	var keys []string
	for key := range fake.objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	want := []string{"app/app/dev", "lock/app/dev", "passphrase/app/dev", "secret/app/dev", "update/app/dev/" + update.ID}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Fatalf("expected %v, got %v", want, keys)
	}
}

// A write Cloudflare rate limits is sent again, whole.
func TestCloudflareHomeRetriesWholeWrites(t *testing.T) {
	t.Parallel()
	for _, compress := range []bool{false, true} {
		fake := &fakeR2{objects: map[string][]byte{}, failPuts: 1}
		home := newFakeCloudflareHome(t, fake, compress)
		state := checkpoint("app", "dev", 2)
		if err := PushPartialState(home, "id", "app", "dev", state); err != nil {
			t.Fatal(err)
		}
		got, err := home.Get(t.Context(), Key{Kind: "app", App: "app", Stage: "dev"})
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(state) {
			t.Fatalf("compress %v: the retried write stored %d bytes, not the state's %d", compress, len(got), len(state))
		}
	}
}
