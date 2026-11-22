package resource

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/cloudfrontkeyvaluestore"
	"github.com/stretchr/testify/require"
)

const testStore = "arn:aws:cloudfront::test:key-value-store/routes"

// fakeKvStore answers the CloudFront KeyValueStore calls the routes resource
// makes (DescribeKeyValueStore, GetKey, UpdateKeys) from an in-memory map
type fakeKvStore struct {
	keys map[string]string
	etag int
}

func (f *fakeKvStore) RoundTrip(req *http.Request) (*http.Response, error) {
	reply := func(status int, header http.Header, body string) (*http.Response, error) {
		if header == nil {
			header = http.Header{}
		}
		header.Set("Content-Type", "application/json")
		return &http.Response{
			StatusCode: status,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    req,
		}, nil
	}
	etag := http.Header{"Etag": []string{fmt.Sprint(f.etag)}}
	path := req.URL.EscapedPath()
	switch {
	case req.Method == http.MethodGet && strings.Contains(path, "/keys/"):
		key, _ := url.PathUnescape(path[strings.LastIndex(path, "/")+1:])
		value, ok := f.keys[key]
		if !ok {
			h := http.Header{"X-Amzn-Errortype": []string{"ResourceNotFoundException"}}
			return reply(http.StatusNotFound, h, `{"message":"not found"}`)
		}
		body, _ := json.Marshal(map[string]any{"Key": key, "Value": value, "ItemCount": len(f.keys), "TotalSizeInBytes": 0})
		return reply(http.StatusOK, etag, string(body))
	case req.Method == http.MethodGet:
		return reply(http.StatusOK, etag, `{"ItemCount":0,"TotalSizeInBytes":0}`)
	case req.Method == http.MethodPost && strings.HasSuffix(path, "/keys"):
		var in struct {
			Puts    []struct{ Key, Value string }
			Deletes []struct{ Key string }
		}
		body, _ := io.ReadAll(req.Body)
		if err := json.Unmarshal(body, &in); err != nil {
			return nil, err
		}
		for _, d := range in.Deletes {
			delete(f.keys, d.Key)
		}
		for _, p := range in.Puts {
			f.keys[p.Key] = p.Value
		}
		f.etag++
		return reply(http.StatusOK, nil, fmt.Sprintf(`{"ETag":"%d","ItemCount":%d,"TotalSizeInBytes":0}`, f.etag, len(f.keys)))
	}
	return nil, fmt.Errorf("unexpected request %s %s", req.Method, path)
}

// routes reads the route list stored at key, joining chunks like getRoutes.
// nil means the key is not there.
func (f *fakeKvStore) routes(t *testing.T, key string) []string {
	value, ok := f.keys[key]
	if !ok {
		return nil
	}
	var meta map[string]int
	if json.Unmarshal([]byte(value), &meta) == nil && meta["parts"] > 0 {
		value = ""
		for i := 0; i < meta["parts"]; i++ {
			value += f.keys[fmt.Sprintf("%s:%d", key, i)]
		}
	}
	routes := []string{}
	require.NoError(t, json.Unmarshal([]byte(value), &routes))
	return routes
}

func newFakeKvRoutes(t *testing.T, existing []string) (*KvRoutesUpdate, *fakeKvStore) {
	f := &fakeKvStore{keys: map[string]string{}}
	r := &KvRoutesUpdate{NewAwsResource(context.Background(), func() (aws.Config, error) {
		return aws.Config{
			Region:           "us-east-1",
			Credentials:      credentials.NewStaticCredentialsProvider("AKID", "SECRET", ""),
			HTTPClient:       &http.Client{Transport: f},
			RetryMaxAttempts: 1,
		}, nil
	})}
	if existing != nil {
		// store the starting list the way setRoutes does, chunks included
		client := mustKvClient(t, r)
		require.NoError(t, r.setRoutes(client, testStore, "0", "ns:routes", existing, 1))
	}
	return r, f
}

func mustKvClient(t *testing.T, r *KvRoutesUpdate) *cloudfrontkeyvaluestore.Client {
	cfg, err := r.config()
	require.NoError(t, err)
	return cloudfrontkeyvaluestore.NewFromConfig(cfg)
}

func manyRoutes(n int) []string {
	routes := make([]string, n)
	for i := range routes {
		routes[i] = fmt.Sprintf("/route-%03d-padding-to-make-the-list-long", i)
	}
	return routes
}

// TestKvRoutesCreate pins which entry lists Create leaves in the store
func TestKvRoutesCreate(t *testing.T) {
	long := manyRoutes(60)
	cases := []struct {
		name     string
		existing []string // nil: the key does not exist yet
		entry    string
		want     []string
	}{
		{"missing key", nil, "/a", []string{"/a"}},
		{"empty list", []string{}, "/a", []string{"/a"}},
		{"new entry goes last", []string{"/b", "/a"}, "/c", []string{"/b", "/a", "/c"}},
		{"exact match is not added again", []string{"/b", "/a"}, "/a", []string{"/b", "/a"}},
		{"duplicates are kept as they are", []string{"/a", "/a"}, "/a", []string{"/a", "/a"}},
		{"prefix is not a match", []string{"/api"}, "/api/v2", []string{"/api", "/api/v2"}},
		{"longer entry is not a match", []string{"/api/v2"}, "/api", []string{"/api/v2", "/api"}},
		{"case matters", []string{"/API"}, "/api", []string{"/API", "/api"}},
		{"trailing space matters", []string{"/a "}, "/a", []string{"/a ", "/a"}},
		{"empty entry is added", []string{"/a"}, "", []string{"/a", ""}},
		{"empty entry matches empty entry", []string{""}, "", []string{""}},
		{"chunked list, existing entry", long, long[30], long},
		{"chunked list, new entry", long, "/new", append(append([]string{}, long...), "/new")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, f := newFakeKvRoutes(t, tc.existing)
			var out CreateResult[KvRoutesUpdateOutputs]
			require.NoError(t, r.Create(&KvRoutesUpdateInputs{Store: testStore, Namespace: "ns", Key: "routes", Entry: tc.entry}, &out))
			require.Equal(t, tc.want, f.routes(t, "ns:routes"))
			require.Equal(t, testStore+":ns:routes", out.ID)
		})
	}
}

// TestKvRoutesUpdate pins the entry lists Update leaves when only the entry
// changes: the old entry is dropped everywhere, the new one goes last unless
// it is already there
func TestKvRoutesUpdate(t *testing.T) {
	long := manyRoutes(60)
	cases := []struct {
		name     string
		existing []string
		old, new string
		want     []string
	}{
		{"replace", []string{"/a", "/b"}, "/a", "/c", []string{"/b", "/c"}},
		{"same entry moves last", []string{"/a", "/b"}, "/a", "/a", []string{"/b", "/a"}},
		{"new entry already there", []string{"/a", "/b"}, "/a", "/b", []string{"/b"}},
		{"old duplicates all go", []string{"/a", "/b", "/a"}, "/a", "/c", []string{"/b", "/c"}},
		{"new duplicates are kept", []string{"/b", "/a", "/b"}, "/a", "/b", []string{"/b", "/b"}},
		{"old entry not there", []string{"/b"}, "/a", "/c", []string{"/b", "/c"}},
		{"only entry replaced", []string{"/a"}, "/a", "/c", []string{"/c"}},
		{"missing key", nil, "/a", "/c", []string{"/c"}},
		{"prefix is not a match", []string{"/api/v2"}, "/x", "/api", []string{"/api/v2", "/api"}},
		{"case matters", []string{"/API"}, "/x", "/api", []string{"/API", "/api"}},
		{"chunked list", long, long[0], long[1], long[1:]},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, f := newFakeKvRoutes(t, tc.existing)
			olds := KvRoutesUpdateOutputs{Store: testStore, Namespace: "ns", Key: "routes", Entry: tc.old}
			news := KvRoutesUpdateInputs{Store: testStore, Namespace: "ns", Key: "routes", Entry: tc.new}
			var out UpdateResult[KvRoutesUpdateOutputs]
			require.NoError(t, r.Update(&UpdateInput[KvRoutesUpdateInputs, KvRoutesUpdateOutputs]{ID: testStore + ":ns:routes", News: news, Olds: olds}, &out))
			require.Equal(t, tc.want, f.routes(t, "ns:routes"))
			require.Equal(t, tc.new, out.Outs.Entry)
		})
	}
}

// TestKvRoutesDelete pins Delete: every copy of the entry goes, and the key
// itself goes with the last entry
func TestKvRoutesDelete(t *testing.T) {
	cases := []struct {
		name     string
		existing []string
		entry    string
		want     []string // nil: the key is gone
	}{
		{"remove one", []string{"/a", "/b"}, "/a", []string{"/b"}},
		{"remove duplicates", []string{"/a", "/b", "/a"}, "/a", []string{"/b"}},
		{"not there", []string{"/b"}, "/a", []string{"/b"}},
		{"prefix is not a match", []string{"/api/v2"}, "/api", []string{"/api/v2"}},
		{"last entry removes the key", []string{"/a"}, "/a", nil},
		{"last duplicates remove the key", []string{"/a", "/a"}, "/a", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, f := newFakeKvRoutes(t, tc.existing)
			var out int
			require.NoError(t, r.Delete(&DeleteInput[KvRoutesUpdateOutputs]{ID: testStore + ":ns:routes", Outs: KvRoutesUpdateOutputs{Store: testStore, Namespace: "ns", Key: "routes", Entry: tc.entry}}, &out))
			require.Equal(t, tc.want, f.routes(t, "ns:routes"))
		})
	}
}
