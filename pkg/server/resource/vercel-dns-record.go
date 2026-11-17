package resource

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"strings"
)

// VercelResource is what SST's Vercel resources share: the context their
// calls run in, and the token for Vercel's API: VERCEL_API_TOKEN under SST's
// CLI, or the one a program Pulumi runs on its own gives the provider the sst
// binary serves (pkg/provider).
type VercelResource struct {
	context context.Context
	token   func() string
}

// NewVercelResource is a VercelResource whose calls run in ctx, with the
// token token gives, which the provider finds (pkg/provider)
func NewVercelResource(ctx context.Context, token func() string) *VercelResource {
	return &VercelResource{ctx, token}
}

// authorize sets the token for Vercel's API on a request. It's not in the
// resource's inputs, which are saved to the state.
func (r *VercelResource) authorize(req *http.Request) error {
	token := ""
	if r.token != nil {
		token = r.token()
	}
	if token == "" {
		return fmt.Errorf("There's no access token for Vercel's API: set VERCEL_API_TOKEN, or the stack's vercel:apiToken")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return nil
}

type VercelDnsRecord struct {
	*VercelResource
}

type VercelDnsRecordInputs struct {
	Domain     string `json:"domain"`
	Type       string `json:"type"`
	Name       string `json:"name"`
	Value      string `json:"value"`
	MxPriority int    `json:"mxPriority,omitempty"`
	TeamId     string `json:"teamId,omitempty"`
}

type VercelDnsRecordOutputs struct {
	RecordId string `json:"recordId"`
}


func (r *VercelDnsRecord) Create(input *VercelDnsRecordInputs, output *CreateResult[VercelDnsRecordOutputs]) error {
	recordId, err := r.createOrUpdateRecord(input)
	if err != nil {
		return err
	}

	*output = CreateResult[VercelDnsRecordOutputs]{
		ID:   recordId,
		Outs: VercelDnsRecordOutputs{RecordId: recordId},
	}
	return nil
}

func (r *VercelDnsRecord) Update(input *UpdateInput[VercelDnsRecordInputs, VercelDnsRecordOutputs], output *UpdateResult[VercelDnsRecordOutputs]) error {
	recordId, err := r.createOrUpdateRecord(&input.News)
	if err != nil {
		return err
	}

	*output = UpdateResult[VercelDnsRecordOutputs]{
		Outs: VercelDnsRecordOutputs{RecordId: recordId},
	}
	return nil
}

func (r *VercelDnsRecord) createOrUpdateRecord(input *VercelDnsRecordInputs) (string, error) {
	// Construct the URL with the team if there is one
	url := fmt.Sprintf("https://api.vercel.com/v4/domains/%s/records", input.Domain)
	if input.TeamId != "" {
		url = fmt.Sprintf("%s?%s", url, teamQuery(input.TeamId))
	}
	
	// Use the input type, name, and value for the DNS record. MxPriority is only
	// relevant for MX records; omitempty drops it for other types.
	recordPayload := struct {
		Type       string `json:"type"`
		Name       string `json:"name"`
		Value      string `json:"value"`
		MxPriority int    `json:"mxPriority,omitempty"`
		Ttl        int    `json:"ttl"`
	}{
		Type:       input.Type,
		Name:       input.Name,
		Value:      input.Value,
		MxPriority: input.MxPriority,
		Ttl:        60,
	}
	
	payloadBytes, err := json.Marshal(recordPayload)
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
	
	// Check if the response was successful
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Check for "record_exists" error
		errorMsg := string(body)
		
		// Parse error response
		var errorResponse struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		
		if err := json.Unmarshal(body, &errorResponse); err == nil && 
		   errorResponse.Error.Code == "record_exists" {
			// If the record already exists, we'll treat this as a success
			// We can attempt to find the existing record ID, but for now we'll just return a placeholder
			return "existing-record", nil
		}
		
		// Also check for legacy error messages for backward compatibility
		if resp.StatusCode == 400 && (bytes.Contains(body, []byte("already exists")) || 
		                            bytes.Contains(body, []byte("already registered"))) {
			return "existing-record", nil
		}
		
		return "", fmt.Errorf("failed to create DNS record, status: %d, response: %s", resp.StatusCode, errorMsg)
	}
	
	// Parse the response
	var apiResponse struct {
		Uid       string `json:"uid"`
	}
	err = json.Unmarshal(body, &apiResponse)
	if err != nil {
		return "", err
	}
	
	return apiResponse.Uid, nil
}

// teamQuery is the query that names a team: by its ID, which starts with
// "team_", or by its slug, which Pulumi's Vercel provider takes as its team
// too
func teamQuery(team string) string {
	if strings.HasPrefix(team, "team_") {
		return "teamId=" + neturl.QueryEscape(team)
	}
	return "slug=" + neturl.QueryEscape(team)
}
