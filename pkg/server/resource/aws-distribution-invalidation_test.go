package resource

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/stretchr/testify/require"
)

// fakeAws serves an AWS API with answer, and keeps each request body.
func fakeAws(t *testing.T, answer func(r *http.Request, body string) (int, string)) (*AwsResource, *[]string) {
	t.Helper()
	var mu sync.Mutex
	bodies := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, r.Method+" "+r.URL.Path+" "+string(body))
		mu.Unlock()
		status, response := answer(r, string(body))
		w.WriteHeader(status)
		io.WriteString(w, response)
	}))
	t.Cleanup(server.Close)
	cfg := aws.Config{
		Region:       "us-east-1",
		Credentials:  aws.AnonymousCredentials{},
		BaseEndpoint: aws.String(server.URL),
	}
	return NewAwsResource(context.Background(), func() (aws.Config, error) { return cfg, nil }), &bodies
}

func paths(prefix string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("/%s%d%s", prefix, i, map[bool]string{true: "*", false: ""}[prefix == "w"])
	}
	return out
}

// handle sends the paths in batches of at most 3000 files and 15 wildcards,
// files first in each batch, and waits for each batch when there is more than
// one or when asked to.
func TestDistributionInvalidationBatches(t *testing.T) {
	cases := []struct {
		name    string
		files   int
		wild    int
		wait    bool
		batches [][2]int // files and wildcards in each batch
		waits   int
	}{
		{"no paths", 0, 0, false, nil, 0},
		{"few files", 2, 0, false, [][2]int{{2, 0}}, 0},
		{"files and wildcards", 2, 1, false, [][2]int{{2, 1}}, 0},
		{"wait asked", 1, 0, true, [][2]int{{1, 0}}, 1},
		{"exactly 3000 files", 3000, 0, false, [][2]int{{3000, 0}}, 0},
		{"3001 files", 3001, 0, false, [][2]int{{3000, 0}, {1, 0}}, 2},
		{"16 wildcards", 0, 16, false, [][2]int{{0, 15}, {0, 1}}, 2},
		{"31 wildcards and 4 files", 4, 31, false, [][2]int{{4, 15}, {0, 15}, {0, 1}}, 3},
		// more than 3000 files with wildcards: each batch keeps its own files
		{"3000 files and a wildcard", 3000, 1, false, [][2]int{{3000, 1}}, 0},
		{"3001 files and a wildcard", 3001, 1, false, [][2]int{{3000, 1}, {1, 0}}, 2},
		{"6001 files and 2 wildcards", 6001, 2, false, [][2]int{{3000, 2}, {3000, 0}, {1, 0}}, 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, calls := fakeAws(t, func(r *http.Request, body string) (int, string) {
				if r.Method == "POST" {
					return 201, `<Invalidation><Id>I1</Id><Status>InProgress</Status></Invalidation>`
				}
				return 200, `<Invalidation><Id>I1</Id><Status>Completed</Status></Invalidation>`
			})
			files, wild := paths("f", tc.files), paths("w", tc.wild)
			err := (&DistributionInvalidation{res}).handle(&DistributionInvalidationInputs{
				DistributionId: "D1",
				Paths:          append(append([]string{}, files...), wild...),
				Wait:           tc.wait,
			})
			require.NoError(t, err)

			var got [][2]int
			waits := 0
			fi, wi := 0, 0
			for _, c := range *calls {
				if strings.HasPrefix(c, "GET ") {
					waits++
					continue
				}
				var batch struct {
					Items []string `xml:"Paths>Items>Path"`
					Qty   int      `xml:"Paths>Quantity"`
				}
				require.NoError(t, xml.Unmarshal([]byte(c[strings.Index(c, "<"):]), &batch))
				require.Equal(t, len(batch.Items), batch.Qty)
				// each batch is the next files, then the next wildcards, in order
				n := [2]int{}
				for _, p := range batch.Items {
					if strings.HasSuffix(p, "*") {
						require.Equal(t, wild[wi], p)
						wi++
						n[1]++
					} else {
						require.Zero(t, n[1], "file after a wildcard")
						require.Equal(t, files[fi], p)
						fi++
						n[0]++
					}
				}
				got = append(got, n)
			}
			require.Equal(t, tc.batches, got)
			require.Equal(t, tc.waits, waits)
		})
	}
}
