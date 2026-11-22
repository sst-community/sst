package resource

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
)

// smithyAPIError is a minimal smithy.APIError implementation used to simulate
// errors that carry a NoSuchBucket code without the modeled *s3types.NoSuchBucket.
type smithyAPIError struct {
	code    string
	message string
}

func (e *smithyAPIError) Error() string                 { return fmt.Sprintf("%s: %s", e.code, e.message) }
func (e *smithyAPIError) ErrorCode() string             { return e.code }
func (e *smithyAPIError) ErrorMessage() string          { return e.message }
func (e *smithyAPIError) ErrorFault() smithy.ErrorFault { return smithy.FaultClient }

func TestIsBucketAbsent(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "typed NoSuchBucket is absent",
			err:  &s3types.NoSuchBucket{},
			want: true,
		},
		{
			name: "wrapped typed NoSuchBucket is absent",
			err:  fmt.Errorf("delete failed: %w", &s3types.NoSuchBucket{}),
			want: true,
		},
		{
			name: "smithy APIError with NoSuchBucket code is absent",
			err:  &smithyAPIError{code: "NoSuchBucket", message: "The specified bucket does not exist"},
			want: true,
		},
		{
			name: "AccessDenied is not absent",
			err:  &smithyAPIError{code: "AccessDenied", message: "Access Denied"},
			want: false,
		},
		{
			name: "generic error is not absent",
			err:  errors.New("connection reset"),
			want: false,
		},
		{
			name: "nil error is not absent",
			err:  nil,
			want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isBucketAbsent(tc.err); got != tc.want {
				t.Fatalf("isBucketAbsent(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestDeleteSwallowsOnlyMissingBucket documents the intended delete-path
// contract that isBucketAbsent gates: a missing bucket is success on delete,
// while AccessDenied (and any other error) must still propagate.
func TestDeleteSwallowsOnlyMissingBucket(t *testing.T) {
	// Simulates the branch in Delete: `if isBucketAbsent(err) { return nil }`.
	deleteResult := func(purgeErr error) error {
		if purgeErr != nil {
			if isBucketAbsent(purgeErr) {
				return nil
			}
			return purgeErr
		}
		return nil
	}

	if err := deleteResult(&s3types.NoSuchBucket{}); err != nil {
		t.Fatalf("missing bucket on delete should succeed, got %v", err)
	}
	accessDenied := &smithyAPIError{code: "AccessDenied", message: "Access Denied"}
	if err := deleteResult(accessDenied); err == nil {
		t.Fatal("AccessDenied on delete must remain an error")
	}
	if err := deleteResult(nil); err != nil {
		t.Fatalf("successful purge should return nil, got %v", err)
	}
}

// uploadFiles puts every file once, with at most 10 uploads at a time.
// Each upload waits until 10 are in flight, so the count does not depend on
// timing; if fewer than 10 run together the wait gives up and the count fails.
func TestUploadFilesWorkers(t *testing.T) {
	var mu sync.Mutex
	inFlight, most := 0, 0
	keys := map[string]string{}
	full := make(chan struct{})
	var fullOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		inFlight++
		most = max(most, inFlight)
		if inFlight == 10 {
			fullOnce.Do(func() { close(full) })
		}
		keys[r.URL.Path] = string(body)
		mu.Unlock()
		select {
		case <-full:
		case <-time.After(5 * time.Second):
		}
		mu.Lock()
		inFlight--
		mu.Unlock()
	}))
	t.Cleanup(server.Close)

	dir := t.TempDir()
	var files []BucketFile
	for i := range 30 {
		src := filepath.Join(dir, fmt.Sprintf("f%d", i))
		if err := os.WriteFile(src, []byte(fmt.Sprintf("body %d", i)), 0644); err != nil {
			t.Fatal(err)
		}
		files = append(files, BucketFile{Source: src, Key: fmt.Sprintf("k%d", i), ContentType: "text/plain"})
	}

	client := s3.NewFromConfig(aws.Config{
		Region:       "us-east-1",
		Credentials:  aws.AnonymousCredentials{},
		BaseEndpoint: aws.String(server.URL),
	}, func(o *s3.Options) { o.UsePathStyle = true })
	r := &BucketFiles{NewAwsResource(context.Background(), nil)}
	if err := r.uploadFiles(client, "bucket", files); err != nil {
		t.Fatal(err)
	}
	if err := r.uploadFiles(client, "bucket", nil); err != nil {
		t.Fatal(err)
	}

	if len(keys) != 30 {
		t.Fatalf("uploaded %d files, want 30", len(keys))
	}
	for i := range 30 {
		if got := keys[fmt.Sprintf("/bucket/k%d", i)]; got != fmt.Sprintf("body %d", i) {
			t.Fatalf("k%d has %q", i, got)
		}
	}
	if most != 10 {
		t.Fatalf("%d uploads at a time, want 10", most)
	}
}

// upload skips a file whose hash, cache-control and content type are the same
// as in the last deploy, and puts it again when any of them changed. The old
// and new values are separate strings, as they are after the state is decoded.
func TestUploadSkipsUnchangedFiles(t *testing.T) {
	var mu sync.Mutex
	puts := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		mu.Lock()
		puts[r.URL.Path] = r.Header.Get("Cache-Control")
		mu.Unlock()
	}))
	t.Cleanup(server.Close)

	dir := t.TempDir()
	src := filepath.Join(dir, "f")
	if err := os.WriteFile(src, []byte("body"), 0644); err != nil {
		t.Fatal(err)
	}
	file := func(key, hash string, cacheControl *string) BucketFile {
		return BucketFile{Source: src, Key: key, ContentType: "text/html", Hash: aws.String(hash), CacheControl: cacheControl}
	}
	old := []BucketFile{
		file("cached.html", "a", aws.String("max-age=0,no-cache")),
		file("plain.css", "a", nil),
		file("recached.js", "a", aws.String("max-age=0")),
		file("edited.js", "a", aws.String("max-age=0")),
	}
	news := []BucketFile{
		file("cached.html", "a", aws.String("max-age=0,no-cache")),
		file("plain.css", "a", nil),
		file("recached.js", "a", aws.String("max-age=31536000,immutable")),
		file("edited.js", "b", aws.String("max-age=0")),
	}

	client := s3.NewFromConfig(aws.Config{
		Region:       "us-east-1",
		Credentials:  aws.AnonymousCredentials{},
		BaseEndpoint: aws.String(server.URL),
	}, func(o *s3.Options) { o.UsePathStyle = true })
	r := &BucketFiles{NewAwsResource(context.Background(), nil)}
	if err := r.upload(client, "bucket", news, old); err != nil {
		t.Fatal(err)
	}

	want := map[string]string{
		"/bucket/recached.js": "max-age=31536000,immutable",
		"/bucket/edited.js":   "max-age=0",
	}
	if len(puts) != len(want) {
		t.Fatalf("uploaded %v, want only %v", puts, want)
	}
	for key, cacheControl := range want {
		if got, ok := puts[key]; !ok || got != cacheControl {
			t.Fatalf("%s uploaded with cache-control %q (uploaded: %v), want %q", key, got, ok, cacheControl)
		}
	}
}
