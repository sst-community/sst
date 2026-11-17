package resource

import (
	"encoding/json"
	"fmt"
	"time"
)

// WorkerUrl turns a Worker's workers.dev URL on or off, and gives it. SST 4
// did this with a dynamic resource of its own, written in TypeScript.
type WorkerUrl struct {
	*CloudflareResource
}

type WorkerUrlInputs struct {
	AccountId  string `json:"accountId"`
	ScriptName string `json:"scriptName"`
	Enabled    bool   `json:"enabled"`
	// The script's etag, so it's set again each time the script is uploaded
	Etag string `json:"etag,omitempty"`
}

type WorkerUrlOutputs struct {
	// The URL, without its scheme, while it's turned on
	Url string `json:"url,omitempty"`
}

// workerUrlSettle is how long to wait once a URL is turned on: a request to
// it right away can be cached as missing for 30 seconds, as Cloudflare told
// Wrangler
var workerUrlSettle = 3 * time.Second

func (r *WorkerUrl) Create(input *WorkerUrlInputs, output *CreateResult[WorkerUrlOutputs]) error {
	url, err := r.process(input)
	if err != nil {
		return err
	}
	*output = CreateResult[WorkerUrlOutputs]{
		ID:   input.ScriptName,
		Outs: WorkerUrlOutputs{Url: url},
	}
	return nil
}

func (r *WorkerUrl) Update(input *UpdateInput[WorkerUrlInputs, WorkerUrlOutputs], output *UpdateResult[WorkerUrlOutputs]) error {
	url, err := r.process(&input.News)
	if err != nil {
		return err
	}
	*output = UpdateResult[WorkerUrlOutputs]{Outs: WorkerUrlOutputs{Url: url}}
	return nil
}

func (r *WorkerUrl) process(input *WorkerUrlInputs) (string, error) {
	body, err := json.Marshal(map[string]bool{"enabled": input.Enabled})
	if err != nil {
		return "", err
	}
	path := fmt.Sprintf("/accounts/%s/workers/scripts/%s/subdomain", input.AccountId, input.ScriptName)
	if err := r.call("POST", path, "application/json", body, nil); err != nil {
		return "", err
	}
	if !input.Enabled {
		return "", nil
	}
	var account struct {
		Subdomain string `json:"subdomain"`
	}
	if err := r.call("GET", fmt.Sprintf("/accounts/%s/workers/subdomain", input.AccountId), "application/json", nil, &account); err != nil {
		return "", err
	}
	select {
	case <-r.context.Done():
		return "", r.context.Err()
	case <-time.After(workerUrlSettle):
	}
	return fmt.Sprintf("%s.%s.workers.dev", input.ScriptName, account.Subdomain), nil
}
