// Package eventflow is the client of an EventFlow's admin API, which its router
// serves, and what `sst eventflow` prints of it.
//
// The router is invoked with { "sst:eventflow:admin": { "op", "args" } } and
// answers { "ok": true, "result" } or { "ok": false, "error": { "name", "message" } }.
package eventflow

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/project/common"
)

// LinkType is the type in an EventFlow's link properties
const LinkType = "sst.aws.EventFlow"

const adminMarker = "sst:eventflow:admin"

// Target is an EventFlow of the stage, from its link
type Target struct {
	// Name is the component's name, the link's key
	Name       string
	RouterName string
	QueueURL   string
}

// Find picks the EventFlow called name from a stage's links, or the only one
// when name is empty
func Find(links common.Links, name string) (Target, error) {
	flows := map[string]Target{}
	for key, link := range links {
		if t, _ := link.Properties["type"].(string); t != LinkType {
			continue
		}
		router, _ := link.Properties["routerName"].(string)
		queue, _ := link.Properties["queueUrl"].(string)
		flows[key] = Target{Name: key, RouterName: router, QueueURL: queue}
	}
	names := make([]string, 0, len(flows))
	for key := range flows {
		names = append(names, key)
	}
	slices.Sort(names)
	choices := strings.Join(names, ", ")

	if len(flows) == 0 {
		return Target{}, util.NewReadableError(nil, "This stage has no EventFlow. Deploy one first.")
	}
	if name == "" {
		if len(flows) > 1 {
			return Target{}, util.NewReadableError(nil, "This stage has more than one EventFlow. Pick one with --name: "+choices)
		}
		name = names[0]
	}
	target, ok := flows[name]
	if !ok {
		return Target{}, util.NewReadableError(nil, fmt.Sprintf("This stage has no EventFlow called %q. Its EventFlows are: %s", name, choices))
	}
	if target.RouterName == "" {
		return Target{}, util.NewReadableError(nil, fmt.Sprintf("The EventFlow %q has no router in its link. Deploy it again.", name))
	}
	return target, nil
}

// Invoker invokes a Lambda function synchronously, and returns its payload
// and, if the function failed, its FunctionError
type Invoker func(ctx context.Context, function string, payload []byte) ([]byte, string, error)

// Client calls an EventFlow's admin API
type Client struct {
	Router string
	Invoke Invoker
}

// NewClient is a client of the router, with the AWS config given
func NewClient(cfg aws.Config, router string) *Client {
	lc := lambda.NewFromConfig(cfg)
	return &Client{
		Router: router,
		Invoke: func(ctx context.Context, function string, payload []byte) ([]byte, string, error) {
			out, err := lc.Invoke(ctx, &lambda.InvokeInput{
				FunctionName:   aws.String(function),
				InvocationType: types.InvocationTypeRequestResponse,
				Payload:        payload,
			})
			if err != nil {
				return nil, "", err
			}
			return out.Payload, aws.ToString(out.FunctionError), nil
		},
	}
}

// AdminError is an error the admin API answered with
type AdminError struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

func (e *AdminError) Error() string {
	if e.Name == "" || e.Name == "Error" {
		return e.Message
	}
	return e.Name + ": " + e.Message
}

// Request is the payload that calls op with args
func Request(op string, args any) ([]byte, error) {
	if args == nil {
		args = map[string]any{}
	}
	return json.Marshal(map[string]any{adminMarker: map[string]any{"op": op, "args": args}})
}

// Call calls op with args, decodes the result into out when it isn't nil, and
// returns the result as it came
func (c *Client) Call(ctx context.Context, op string, args any, out any) (json.RawMessage, error) {
	payload, err := Request(op, args)
	if err != nil {
		return nil, err
	}
	body, functionError, err := c.Invoke(ctx, c.Router, payload)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, util.NewHintedError(err, fmt.Sprintf("Could not invoke the EventFlow's router %s", c.Router))
	}
	result, err := decode(body, functionError)
	if err != nil {
		return nil, err
	}
	if out != nil {
		if err := json.Unmarshal(result, out); err != nil {
			return nil, fmt.Errorf("could not read the result of %s: %w", op, err)
		}
	}
	return result, nil
}

// SnapshotRuns is how many of the latest runs the live view shows
const SnapshotRuns = 10

// Snapshot asks for what the live view shows, all at once, and returns it
// decoded and as it came, by part
func (c *Client) Snapshot(ctx context.Context) (Snapshot, map[string]json.RawMessage, error) {
	var s Snapshot
	parts := []struct {
		key, op string
		args    any
		out     any
	}{
		{"overview", "overview", nil, &s.Overview},
		{"functions", "functions", nil, &s.Functions},
		{"leases", "leases", nil, &s.Limits},
		{"waits", "waits", nil, &s.Waits},
		{"runs", "runs.list", ListArgs{Limit: SnapshotRuns}, &s.Runs},
	}
	raws := make([]json.RawMessage, len(parts))
	errs := make([]error, len(parts))
	var wg sync.WaitGroup
	for i, part := range parts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			raws[i], errs[i] = c.Call(ctx, part.op, part.args, part.out)
		}()
	}
	wg.Wait()
	raw := map[string]json.RawMessage{}
	for i, part := range parts {
		if errs[i] != nil {
			return Snapshot{}, nil, errs[i]
		}
		raw[part.key] = raws[i]
	}
	return s, raw, nil
}

// decode reads the router's answer
func decode(body []byte, functionError string) (json.RawMessage, error) {
	if functionError != "" {
		var crash struct {
			ErrorType    string `json:"errorType"`
			ErrorMessage string `json:"errorMessage"`
		}
		json.Unmarshal(body, &crash)
		msg := strings.TrimSpace(crash.ErrorType + ": " + crash.ErrorMessage)
		if crash.ErrorType == "" && crash.ErrorMessage == "" {
			msg = strings.TrimSpace(string(body))
		}
		return nil, util.NewReadableError(nil, fmt.Sprintf("The EventFlow's router failed (%s): %s", functionError, msg))
	}
	var response struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *AdminError     `json:"error"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, util.NewReadableError(err, "The EventFlow's router gave an answer that isn't JSON. Is the router up to date? Deploy it again.")
	}
	if !response.OK {
		if response.Error == nil {
			return nil, util.NewReadableError(nil, "The EventFlow's router didn't answer the admin request. Is it up to date? Deploy it again.")
		}
		return nil, util.NewReadableError(response.Error, response.Error.Error())
	}
	if len(response.Result) == 0 {
		return json.RawMessage("null"), nil
	}
	return response.Result, nil
}

// What the admin API returns, as admin.ts and runs.ts in the JS SDK give it

type Function struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Triggers    []Trigger     `json:"triggers"`
	Retries     int           `json:"retries"`
	Concurrency []Concurrency `json:"concurrency"`
	Throttle    *struct {
		PerSecond float64 `json:"perSecond"`
		Burst     float64 `json:"burst"`
	} `json:"throttle,omitempty"`
	RateLimit *struct {
		PerSecond float64 `json:"perSecond"`
	} `json:"rateLimit,omitempty"`
	Idempotency bool `json:"idempotency"`
	CancelOn    []struct {
		Event string `json:"event"`
		Match string `json:"match,omitempty"`
		If    string `json:"if,omitempty"`
	} `json:"cancelOn"`
}

type Trigger struct {
	Event    string `json:"event,omitempty"`
	If       string `json:"if,omitempty"`
	Cron     string `json:"cron,omitempty"`
	Timezone string `json:"timezone,omitempty"`
	Invoke   bool   `json:"invoke,omitempty"`
}

type Concurrency struct {
	Limit int    `json:"limit"`
	Scope string `json:"scope"`
	Key   string `json:"key,omitempty"`
}

type Overview struct {
	Functions int `json:"functions"`
	Queue     struct {
		Waiting  int `json:"waiting"`
		InFlight int `json:"inFlight"`
		Delayed  int `json:"delayed"`
	} `json:"queue"`
	DeadLetters struct {
		Count int `json:"count"`
	} `json:"deadLetters"`
	Leases struct {
		Limits int `json:"limits"`
		Full   int `json:"full"`
	} `json:"leases"`
	Waits struct {
		Waits     int `json:"waits"`
		CancelOns int `json:"cancelOns"`
	} `json:"waits"`
}

type Limit struct {
	Label   string         `json:"label"`
	Limit   *int           `json:"limit,omitempty"`
	Active  int            `json:"active"`
	Queued  int            `json:"queued"`
	Tenants map[string]int `json:"tenants"`
}

type Wait struct {
	Kind      string    `json:"kind"`
	Event     string    `json:"event"`
	Tenant    string    `json:"tenant,omitempty"`
	Field     string    `json:"field"`
	Run       string    `json:"run"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type DeadLetter struct {
	MessageID    string     `json:"messageId"`
	ReceiveCount int        `json:"receiveCount"`
	SentAt       *time.Time `json:"sentAt,omitempty"`
	Kind         string     `json:"kind,omitempty"`
	Event        *struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Tenant string `json:"tenant,omitempty"`
	} `json:"event,omitempty"`
	Body string `json:"body,omitempty"`
}

type RunSummary struct {
	ID        string     `json:"id"`
	Arn       string     `json:"arn"`
	Status    string     `json:"status"`
	StartedAt time.Time  `json:"startedAt"`
	EndedAt   *time.Time `json:"endedAt,omitempty"`
}

type Run struct {
	RunSummary
	Function string `json:"function"`
	Event    struct {
		ID     string          `json:"id"`
		Name   string          `json:"name"`
		Data   json.RawMessage `json:"data"`
		Ts     int64           `json:"ts"`
		Tenant string          `json:"tenant,omitempty"`
	} `json:"event"`
	Version    string          `json:"version,omitempty"`
	Output     json.RawMessage `json:"output,omitempty"`
	Error      *AdminError     `json:"error,omitempty"`
	ReplayOf   string          `json:"replayOf,omitempty"`
	Reused     []string        `json:"reused,omitempty"`
	Steps      []Step          `json:"steps"`
	FailedStep *Step           `json:"failedStep,omitempty"`
	Links      struct {
		Logs     string `json:"logs"`
		LogGroup string `json:"logGroup"`
	} `json:"links"`
}

type Step struct {
	ID        string      `json:"id"`
	Type      string      `json:"type"`
	Status    string      `json:"status"`
	Attempts  int         `json:"attempts"`
	StartedAt *time.Time  `json:"startedAt,omitempty"`
	EndedAt   *time.Time  `json:"endedAt,omitempty"`
	Error     *AdminError `json:"error,omitempty"`
}

type Rerun struct {
	ID       string   `json:"id"`
	ReplayOf string   `json:"replayOf"`
	Reused   []string `json:"reused,omitempty"`
	// Existing is set when the run was already rerun: ID is that run
	Existing bool `json:"existing,omitempty"`
}

type RerunResult struct {
	ID     string `json:"id"`
	Result *struct {
		ID       string `json:"id"`
		Existing bool   `json:"existing,omitempty"`
	} `json:"result,omitempty"`
	Error string `json:"error,omitempty"`
}

type Cancelled struct {
	ID      string `json:"id"`
	Stopped bool   `json:"stopped"`
}

type Redrive struct {
	TaskHandle string `json:"taskHandle"`
}

type Sent struct {
	IDs []string `json:"ids"`
}
