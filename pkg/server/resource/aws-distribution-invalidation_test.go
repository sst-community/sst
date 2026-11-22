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

// fakeCloudFront serves the CloudFront API on a local server and returns the
// path list of each CreateInvalidation call.
func fakeCloudFront(t *testing.T) (*AwsResource, *[][]string) {
	t.Helper()
	var mu sync.Mutex
	batches := [][]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			io.WriteString(w, `<Invalidation><Id>I1</Id><Status>Completed</Status></Invalidation>`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var batch struct {
			Items []string `xml:"Paths>Items>Path"`
			Qty   int      `xml:"Paths>Quantity"`
		}
		if err := xml.Unmarshal(body, &batch); err != nil || batch.Qty != len(batch.Items) {
			t.Errorf("bad invalidation request: %v %s", err, body)
		}
		mu.Lock()
		batches = append(batches, batch.Items)
		mu.Unlock()
		w.WriteHeader(201)
		io.WriteString(w, `<Invalidation><Id>I1</Id><Status>InProgress</Status></Invalidation>`)
	}))
	t.Cleanup(server.Close)
	cfg := aws.Config{
		Region:       "us-east-1",
		Credentials:  aws.AnonymousCredentials{},
		BaseEndpoint: aws.String(server.URL),
	}
	return NewAwsResource(context.Background(), func() (aws.Config, error) { return cfg, nil }), &batches
}

// Each path is sent exactly once, in batches of at most 3000 files and 15
// wildcards, even when the files fill more than one batch.
func TestDistributionInvalidationBatches(t *testing.T) {
	cases := []struct {
		files, wildcards int
		batches          [][2]int // files and wildcards in each batch
	}{
		{3000, 1, [][2]int{{3000, 1}}},
		{3001, 1, [][2]int{{3000, 1}, {1, 0}}},
		{6001, 2, [][2]int{{3000, 2}, {3000, 0}, {1, 0}}},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("%d files %d wildcards", tc.files, tc.wildcards), func(t *testing.T) {
			res, batches := fakeCloudFront(t)
			var input []string
			for i := range tc.files {
				input = append(input, fmt.Sprintf("/file%d", i))
			}
			for i := range tc.wildcards {
				input = append(input, fmt.Sprintf("/dir%d/*", i))
			}
			err := (&DistributionInvalidation{res}).handle(&DistributionInvalidationInputs{
				DistributionId: "D1",
				Paths:          input,
			})
			require.NoError(t, err)

			seen := map[string]int{}
			var sizes [][2]int
			for _, batch := range *batches {
				n := [2]int{}
				for _, p := range batch {
					seen[p]++
					if strings.HasSuffix(p, "*") {
						n[1]++
					} else {
						n[0]++
					}
				}
				sizes = append(sizes, n)
			}
			require.Equal(t, tc.batches, sizes)
			require.Len(t, seen, len(input))
			for _, p := range input {
				require.Equal(t, 1, seen[p], "times %s was sent", p)
			}
		})
	}
}
