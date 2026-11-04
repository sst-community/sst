package resource

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	cloudflare "github.com/cloudflare/cloudflare-go"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// CloudflareResource is what SST's Cloudflare resources share: the context
// their calls run in, and where they get the credentials for Cloudflare's API.
// The RPC reads them from the project's provider, and the provider the sst
// binary serves (pkg/provider) from its environment, so both run the same
// code. They're never in a resource's inputs, which are saved to the state.
type CloudflareResource struct {
	context context.Context
	load    func() (*cloudflare.API, error)
}

// NewCloudflareResource is a CloudflareResource whose calls run in ctx, with
// the credentials load gives. load is called for each request.
func NewCloudflareResource(ctx context.Context, load func() (*cloudflare.API, error)) *CloudflareResource {
	return &CloudflareResource{ctx, load}
}

// projectCloudflare is the credentials the CLI has for Cloudflare's API: the
// app's cloudflare provider's, or else the environment's
func projectCloudflare(p *project.Project) func() (*cloudflare.API, error) {
	return func() (*cloudflare.API, error) {
		if loaded, ok := p.Provider("cloudflare"); ok {
			cf, ok := loaded.(*provider.CloudflareProvider)
			if !ok {
				return nil, fmt.Errorf("the cloudflare provider is a %T", loaded)
			}
			return cf.Api(), nil
		}
		return provider.NewCloudflareAPI(nil)
	}
}

// authorize sets the credentials on a request to Cloudflare's API
func (r *CloudflareResource) authorize(req *http.Request) error {
	api, err := r.load()
	if err != nil {
		return err
	}
	provider.AuthorizeCloudflare(api, req)
	return nil
}

type CloudflareDnsRecord struct {
	*CloudflareResource
}

type Data struct {
	Flags string `json:"flags"`
	Tag   string `json:"tag"`
	Value string `json:"value"`
}

type CloudflareDnsRecordInputs struct {
	ZoneId   string  `json:"zoneId"`
	Type     string  `json:"type"`
	Name     string  `json:"name"`
	Value    *string `json:"value,omitempty"`
	Proxied  *bool   `json:"proxied,omitempty"`
	Data     *Data   `json:"data,omitempty"`
}

type CloudflareDnsRecordOutputs struct {
	RecordId string `json:"recordId"`
}

func (r *CloudflareDnsRecord) Create(input *CloudflareDnsRecordInputs, output *CreateResult[CloudflareDnsRecordOutputs]) error {
	recordId, err := r.createOrUpdateRecord(input)
	if err != nil {
		return err
	}

	*output = CreateResult[CloudflareDnsRecordOutputs]{
		ID:   recordId,
		Outs: CloudflareDnsRecordOutputs{RecordId: recordId},
	}
	return nil
}

func (r *CloudflareDnsRecord) Update(input *UpdateInput[CloudflareDnsRecordInputs, CloudflareDnsRecordOutputs], output *UpdateResult[CloudflareDnsRecordOutputs]) error {
	recordId, err := r.createOrUpdateRecord(&input.News)
	if err != nil {
		return err
	}

	*output = UpdateResult[CloudflareDnsRecordOutputs]{
		Outs: CloudflareDnsRecordOutputs{RecordId: recordId},
	}
	return nil
}

func (r *CloudflareDnsRecord) createOrUpdateRecord(input *CloudflareDnsRecordInputs) (string, error) {
	// Construct the URL for the DNS record
	url := fmt.Sprintf("%s/zones/%s/dns_records", cloudflareAPI, input.ZoneId)
	
	// Create the payload based on record type
	var payloadBytes []byte
	var err error
	
	// Special handling for records that use the data field
	if input.Data != nil && (input.Type == "CAA" || input.Type == "SRV" || input.Type == "DNSKEY") {
		recordPayload := struct {
			Type    string `json:"type"`
			Name    string `json:"name"`
			Data    *Data  `json:"data"`
			Ttl     int    `json:"ttl"`
		}{
			Type:    input.Type,
			Name:    input.Name,
			Data:    input.Data,
			Ttl:     60,
		}
		payloadBytes, err = json.Marshal(recordPayload)
	} else {
		// Standard handling for other record types
		recordPayload := struct {
			Type    string  `json:"type"`
			Name    string  `json:"name"`
			Content *string `json:"content,omitempty"`
			Ttl     int     `json:"ttl"`
			Proxied *bool   `json:"proxied,omitempty"`
		}{
			Type:    input.Type,
			Name:    input.Name,
			Content: input.Value,
			Ttl:     60,
			Proxied: input.Proxied,
		}
		payloadBytes, err = json.Marshal(recordPayload)
	}
	
	if err != nil {
		return "", err
	}
	
	req, err := http.NewRequestWithContext(r.context, "POST", url, bytes.NewBuffer(payloadBytes))
	if err != nil {
		return "", err
	}
	
	req.Header.Set("Content-Type", "application/json")
	if err := r.authorize(req); err != nil {
		return "", err
	}
	
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	
	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	
	// Define response structures based on Cloudflare API docs
	type CloudflareError struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}

	type CloudflareResponse struct {
		Success  bool              `json:"success"`
		Errors   []CloudflareError `json:"errors"`
		Messages []string          `json:"messages"`
		Result   struct {
			Id string `json:"id"`
		} `json:"result"`
	}

	var apiResponse CloudflareResponse
	if err := json.Unmarshal(body, &apiResponse); err != nil {
		return "", fmt.Errorf("failed to parse API response: %v", err)
	}

	// Check if the response was successful
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !apiResponse.Success {
		// Check for "already exists" in error messages
		if len(apiResponse.Errors) > 0 {
			for _, cfError := range apiResponse.Errors {
				// Check if message contains "already exists" regardless of error code
				if strings.Contains(strings.ToLower(cfError.Message), "already exists") {
					return "existing-record", nil
				}
			}
		}
		
		// If not an "already exists" error, return the error information
		errorMsgs := []string{}
		for _, cfError := range apiResponse.Errors {
			errorMsgs = append(errorMsgs, fmt.Sprintf("%s", cfError.Message))
		}
		
		if len(errorMsgs) > 0 {
			return "", fmt.Errorf("Cloudflare API error: %s", strings.Join(errorMsgs, "; "))
		}
		
		// If we couldn't determine a specific error, return the raw response
		return "", fmt.Errorf("failed to create DNS record, status: %d, response: %s", resp.StatusCode, string(body))
	}
	
	// Success - return the record ID
	return apiResponse.Result.Id, nil
}