package resource

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/textproto"
)

// WorkerPlacement sets where a Worker runs, in its script's settings. SST 4
// did this with a dynamic resource of its own, written in TypeScript, as
// Pulumi's Cloudflare provider took a script's placement as read-only then.
type WorkerPlacement struct {
	*CloudflareResource
}

// WorkerPlacementInputs has one of the ways to place a Worker: Smart Placement
// (`mode`), or near a region, a host or a hostname.
type WorkerPlacementInputs struct {
	AccountId  string `json:"accountId"`
	ScriptName string `json:"scriptName"`
	// The script's etag, the hash of its code, and when it was last uploaded,
	// so it's set again after every upload, which resets it, the code's or not
	Etag       string `json:"etag,omitempty"`
	ModifiedOn string `json:"modifiedOn,omitempty"`
	Mode       string `json:"mode,omitempty"`
	Region     string `json:"region,omitempty"`
	Host       string `json:"host,omitempty"`
	Hostname   string `json:"hostname,omitempty"`
}

type WorkerPlacementOutputs struct {
	AccountId  string `json:"accountId,omitempty"`
	ScriptName string `json:"scriptName"`
}

func (r *WorkerPlacement) Create(input *WorkerPlacementInputs, output *CreateResult[WorkerPlacementOutputs]) error {
	if err := r.patch(input.AccountId, input.ScriptName, placementOf(input)); err != nil {
		return err
	}
	*output = CreateResult[WorkerPlacementOutputs]{
		ID:   input.ScriptName,
		Outs: WorkerPlacementOutputs{AccountId: input.AccountId, ScriptName: input.ScriptName},
	}
	return nil
}

func (r *WorkerPlacement) Update(input *UpdateInput[WorkerPlacementInputs, WorkerPlacementOutputs], output *UpdateResult[WorkerPlacementOutputs]) error {
	if err := r.patch(input.News.AccountId, input.News.ScriptName, placementOf(&input.News)); err != nil {
		return err
	}
	*output = UpdateResult[WorkerPlacementOutputs]{
		Outs: WorkerPlacementOutputs{AccountId: input.News.AccountId, ScriptName: input.News.ScriptName},
	}
	return nil
}

// Delete puts the Worker back where Cloudflare places it by default
func (r *WorkerPlacement) Delete(input *DeleteInput[WorkerPlacementOutputs], output *int) error {
	return r.patch(input.Outs.AccountId, input.Outs.ScriptName, map[string]string{})
}

// placementOf is the first way to place the Worker the inputs give
func placementOf(input *WorkerPlacementInputs) map[string]string {
	switch {
	case input.Mode != "":
		return map[string]string{"mode": input.Mode}
	case input.Region != "":
		return map[string]string{"region": input.Region}
	case input.Host != "":
		return map[string]string{"host": input.Host}
	case input.Hostname != "":
		return map[string]string{"hostname": input.Hostname}
	}
	return map[string]string{}
}

// patch writes the placement into the script's settings, which Cloudflare's
// API takes as a form with a part named `settings`
func (r *WorkerPlacement) patch(accountId, scriptName string, placement map[string]string) error {
	settings, err := json.Marshal(map[string]any{"placement": placement})
	if err != nil {
		return err
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {`form-data; name="settings"; filename="blob"`},
		"Content-Type":        {"application/json"},
	})
	if err != nil {
		return err
	}
	if _, err := part.Write(settings); err != nil {
		return err
	}
	if err := form.Close(); err != nil {
		return err
	}
	path := fmt.Sprintf("/accounts/%s/workers/scripts/%s/settings", accountId, scriptName)
	return r.call("PATCH", path, form.FormDataContentType(), body.Bytes(), nil)
}
