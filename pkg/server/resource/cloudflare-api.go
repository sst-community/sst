package resource

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// cloudflareAPI is where Cloudflare's API is: CLOUDFLARE_API_BASE_URL, as
// Wrangler and SST 4's cfFetch read it, or Cloudflare's own. Tests point it at
// a server of their own.
var cloudflareAPI = func() string {
	if base := os.Getenv("CLOUDFLARE_API_BASE_URL"); base != "" {
		return strings.TrimSuffix(base, "/")
	}
	return "https://api.cloudflare.com/client/v4"
}()

// cloudflareRetries is how long to wait before each try again of a call to
// Cloudflare's API that failed, as SST 4's cfFetch did
var cloudflareRetries = []time.Duration{200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond}

// cloudflareResponse is the envelope Cloudflare's API answers in
type cloudflareResponse struct {
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
	Result json.RawMessage `json:"result"`
}

// call sends a request to Cloudflare's API, with the CLI's credentials, and
// reads what it gives back into result, unless that's nil. A call that fails
// is tried three more times.
func (r *CloudflareResource) call(method, path, contentType string, body []byte, result any) error {
	var last error
	for attempt := 0; ; attempt++ {
		last = r.callOnce(method, path, contentType, body, result)
		if last == nil || attempt >= len(cloudflareRetries) {
			return last
		}
		select {
		case <-r.context.Done():
			return last
		case <-time.After(cloudflareRetries[attempt]):
		}
	}
}

func (r *CloudflareResource) callOnce(method, path, contentType string, body []byte, result any) error {
	req, err := http.NewRequestWithContext(r.context, method, cloudflareAPI+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if err := r.authorize(req); err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var answer cloudflareResponse
	if err := json.Unmarshal(data, &answer); err != nil {
		return fmt.Errorf("a request to the Cloudflare API (%s) failed with status %d", path, resp.StatusCode)
	}
	if !answer.Success {
		messages := []string{}
		for _, e := range answer.Errors {
			messages = append(messages, e.Message)
		}
		return fmt.Errorf("a request to the Cloudflare API (%s) failed: %s", path, strings.Join(messages, "; "))
	}
	if result == nil {
		return nil
	}
	return json.Unmarshal(answer.Result, result)
}
