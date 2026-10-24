package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/appsync"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/id"
)

var version = "0.0.1"
var LAMBDA_RUNTIME_API = os.Getenv("AWS_LAMBDA_RUNTIME_API")
var SST_APP = os.Getenv("SST_APP")
var SST_STAGE = os.Getenv("SST_STAGE")
var SST_FUNCTION_ID = os.Getenv("SST_FUNCTION_ID")
var SST_FUNCTION_TIMEOUT = os.Getenv("SST_FUNCTION_TIMEOUT")
var SST_REGION = os.Getenv("SST_REGION")
var SST_ASSET_BUCKET = os.Getenv("SST_ASSET_BUCKET")
var SST_APPSYNC_HTTP = os.Getenv("SST_APPSYNC_HTTP")
var SST_APPSYNC_REALTIME = os.Getenv("SST_APPSYNC_REALTIME")
var SST_FUNCTION_STREAMING = os.Getenv("SST_FUNCTION_STREAMING")

var ENV_BLACKLIST = map[string]bool{
	"SST_DEBUG_ENDPOINT":              true,
	"SST_DEBUG_SRC_HANDLER":           true,
	"SST_DEBUG_SRC_PATH":              true,
	"AWS_LAMBDA_FUNCTION_MEMORY_SIZE": true,
	"AWS_LAMBDA_LOG_GROUP_NAME":       true,
	"AWS_LAMBDA_LOG_STREAM_NAME":      true,
	"LD_LIBRARY_PATH":                 true,
	"LAMBDA_TASK_ROOT":                true,
	"AWS_LAMBDA_RUNTIME_API":          true,
	"AWS_EXECUTION_ENV":               true,
	"AWS_XRAY_DAEMON_ADDRESS":         true,
	"AWS_LAMBDA_INITIALIZATION_TYPE":  true,
	"PATH":                            true,
	"PWD":                             true,
	"LAMBDA_RUNTIME_DIR":              true,
	"LANG":                            true,
	"NODE_PATH":                       true,
	"SHLVL":                           true,
	"AWS_XRAY_DAEMON_PORT":            true,
	"AWS_XRAY_CONTEXT_MISSING":        true,
	"_HANDLER":                        true,
	"_LAMBDA_CONSOLE_SOCKET":          true,
	"_LAMBDA_CONTROL_SOCKET":          true,
	"_LAMBDA_LOG_FD":                  true,
	"_LAMBDA_RUNTIME_LOAD_TIME":       true,
	"_LAMBDA_SB_ID":                   true,
	"_LAMBDA_SERVER_PORT":             true,
	"_LAMBDA_SHARED_MEM_FD":           true,
}

func main() {
	err := run()
	if err != nil {
		slog.Error("run failed", "err", err)
	}
}

func run() error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGQUIT, syscall.SIGHUP)

	go func() {
		slog.Info("waiting for interrupt signal")
		<-sigs
		slog.Info("got interrupt signal")
		cancel()
	}()
	defer cancel()

	logStreamName := os.Getenv("AWS_LAMBDA_LOG_STREAM_NAME")
	workerID := logStreamName[len(logStreamName)-32:]
	prefix := fmt.Sprintf("/sst/%s/%s", SST_APP, SST_STAGE)
	fmt.Println("prefix", prefix)
	config, err := config.LoadDefaultConfig(ctx, config.WithRegion(SST_REGION))
	if err != nil {
		return err
	}

	conn, err := appsync.Dial(ctx, config, SST_APPSYNC_HTTP, SST_APPSYNC_REALTIME)
	if err != nil {
		return err
	}
	client := bridge.NewClient(ctx, conn, workerID, prefix+"/"+workerID)
	waitForSubscription(ctx, conn, client, prefix+"/"+workerID+"/in")

	init := bridge.InitBody{
		FunctionID:  SST_FUNCTION_ID,
		Environment: []string{},
	}
	for _, e := range os.Environ() {
		key := strings.Split(e, "=")[0]
		if _, ok := ENV_BLACKLIST[key]; ok {
			continue
		}
		init.Environment = append(init.Environment, e)
	}
	sendInit := func() {
		writer := client.NewWriter(bridge.MessageInit, prefix+"/in")
		json.NewEncoder(writer).Encode(init)
		writer.Close()
	}
	sendInit()

	pingTimeout := pingTimeoutOf(SST_FUNCTION_TIMEOUT)

	// Wall clock, so time spent frozen between invocations always counts.
	lastActive := time.Now().Round(0)
	timedOut := false
	for {
		resp, err := http.Get("http://" + LAMBDA_RUNTIME_API + "/2018-06-01/runtime/invocation/next")
		if err != nil {
			cancel()
			return err
		}
		fmt.Println("status", resp.Status)
		requestID := resp.Header.Get("lambda-runtime-aws-request-id")
		deadline := deadlineOf(resp)
		if timedOut || time.Since(lastActive) > 10*time.Second {
			waitForSubscription(ctx, conn, client, prefix+"/"+workerID+"/in")
			timedOut = false
		}
		// read whole first, to tell how to answer the invocation if sst dev
		// doesn't, even when sending it fails partway
		event, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		resp.Body = io.NopCloser(bytes.NewReader(event))
		writer := client.NewWriter(bridge.MessageNext, prefix+"/in")
		if err == nil {
			err = resp.Write(writer)
			// closed even when the write failed, as it waits for what's in
			// flight, and returns the first error
			if closeErr := writer.Close(); err == nil {
				err = closeErr
			}
		}
		if err != nil {
			// sst dev never got the invocation, so fail it now instead of
			// leaving it to Lambda's timeout
			slog.Error("failed to send invocation", slog.String("requestID", requestID), slog.String("error", err.Error()))
			unavailable(requestID, event, "sst dev couldn't be reached to run this invocation (worker: "+workerID+"): "+err.Error())
			timedOut = true
			lastActive = time.Now().Round(0)
			continue
		}
		timeout := pingTimeout

	loop:
		for {
			select {
			case <-ctx.Done():
				return nil
			case msg := <-client.Read():
				if msg.Type == bridge.MessageLogs {
					// a body in several packets can wait for a copy of one that was lost
					go func() { printLogs(readLogs(msg), true) }()
					continue
				}
				fmt.Println("got message", msg.Type)
				if msg.Type == bridge.MessageResponse && msg.ID == requestID {
					responseURL := "http://" + LAMBDA_RUNTIME_API + "/2018-06-01/runtime/invocation/" + requestID + "/response"
					if SST_FUNCTION_STREAMING == "true" {
						req, err := http.NewRequest("POST", responseURL, msg.Body)
						if err != nil {
							fmt.Println("failed to create streaming request", err)
							break loop
						}
						req.Header.Set("Lambda-Runtime-Function-Response-Mode", "streaming")
						req.Header.Set("Transfer-Encoding", "chunked")
						req.Header.Set("Content-Type", "application/vnd.awslambda.http-integration-response")
						if _, err := http.DefaultClient.Do(req); err != nil {
							fmt.Println("failed to send streaming response", err)
						}
					} else {
						http.Post(responseURL, "application/json", msg.Body)
					}
					awaitLogs(ctx, client, msg, deadline, sendInit)
					break loop
				}
				if msg.Type == bridge.MessageError && msg.ID == requestID {
					var body bytes.Buffer
					http.Post("http://"+LAMBDA_RUNTIME_API+"/2018-06-01/runtime/invocation/"+requestID+"/error", "application/json", io.TeeReader(msg.Body, &body))
					awaitLogs(ctx, client, msg, deadline, sendInit)
					printError(msg, "Invoke Error", body.Bytes())
					break loop
				}
				if msg.Type == bridge.MessageInitError {
					var body bytes.Buffer
					http.Post("http://"+LAMBDA_RUNTIME_API+"/2018-06-01/runtime/invocation/"+requestID+"/error", "application/json", io.TeeReader(msg.Body, &body))
					awaitLogs(ctx, client, msg, deadline, sendInit)
					printError(msg, "Init Error", body.Bytes())
					break loop
				}
				if msg.Type == bridge.MessageReboot {
					sendInit()
					continue
				}
				if msg.Type == bridge.MessagePing {
					if isPingFor(msg, writer.ID()) {
						timeout = time.Minute * 15
					}
					continue
				}
			case <-time.After(timeout):
				fmt.Println("timeout", requestID)
				unavailable(requestID, event, "sst dev didn't answer within "+timeout.String()+" (worker: "+workerID+"). Check that `sst dev` is running for this stage.")
				timedOut = true
				break loop
			}
		}
		lastActive = time.Now().Round(0)
	}

}

// How long the bridge waits for sst dev to ping it after it hands over an
// invocation, unless SST_FUNCTION_TIMEOUT sets it in milliseconds. After the
// ping it waits until Lambda times the invocation out.
const defaultPingTimeout = 16 * time.Second

func pingTimeoutOf(value string) time.Duration {
	ms, err := strconv.ParseInt(value, 10, 64)
	if err != nil || ms <= 0 {
		return defaultPingTimeout
	}
	return time.Duration(ms) * time.Millisecond
}

// The error type of an invocation that failed because sst dev didn't run it.
const unavailableErrorType = "SstDevUnavailable"

// unavailable answers an invocation that sst dev didn't run. A request from API
// Gateway, a function URL or a load balancer gets a 500 response with the
// message, which its caller shows. A function error there would only show as a
// bare 502. Anything else, a direct invoke or an event source, gets an error,
// so the invoke fails and an event source retries it instead of counting it
// as done.
func unavailable(requestID string, event []byte, message string) {
	path := "/response"
	errorType := ""
	body, _ := json.Marshal(map[string]any{
		"statusCode": 500,
		"body":       message,
	})
	if !isHTTPEvent(event) {
		path = "/error"
		errorType = unavailableErrorType
		body, _ = json.Marshal(map[string]any{
			"errorType":    unavailableErrorType,
			"errorMessage": message,
			"stackTrace":   []string{},
		})
	}
	req, err := http.NewRequest("POST", "http://"+LAMBDA_RUNTIME_API+"/2018-06-01/runtime/invocation/"+requestID+path, bytes.NewReader(body))
	if err != nil {
		slog.Error("failed to answer invocation", "requestID", requestID, "err", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if errorType != "" {
		req.Header.Set("Lambda-Runtime-Function-Error-Type", errorType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Error("failed to answer invocation", "requestID", requestID, "err", err)
		return
	}
	resp.Body.Close()
}

// isHTTPEvent tells whether an event is a request from API Gateway, a function
// URL or a load balancer, all of which have a requestContext. A WebSocket API
// event has one too, and API Gateway reads its answer as a response as well.
func isHTTPEvent(event []byte) bool {
	var e struct {
		RequestContext json.RawMessage `json:"requestContext"`
	}
	if json.Unmarshal(event, &e) != nil {
		return false
	}
	return len(e.RequestContext) > 0 && string(e.RequestContext) != "null"
}

// awaitLogs prints what the function printed up to a reply, when the CLI says it
// follows the reply. Lambda freezes the bridge once it asks for the next
// invocation, so this is the last moment to print it in this invocation. It
// waits up to logsWait, and never past the invocation's deadline. The output of
// a reply that comes later is printed in a later invocation, marked as late.
func awaitLogs(ctx context.Context, client *bridge.Client, reply bridge.Message, deadline time.Time, sendInit func()) {
	if !reply.LogsFollow {
		return
	}
	wait := logsWait
	if !deadline.IsZero() {
		wait = min(wait, time.Until(deadline)-100*time.Millisecond)
	}
	if wait <= 0 {
		return
	}
	timeout := time.After(wait)
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-client.Read():
			if msg.Type == bridge.MessageReboot {
				sendInit()
				continue
			}
			if msg.Type != bridge.MessageLogs {
				continue
			}
			// a body in several packets can wait for a copy of one that was lost,
			// so it's read without holding up the wait
			read := make(chan bridge.LogsBody, 1)
			go func() { read <- readLogs(msg) }()
			select {
			case body := <-read:
				if body.ReplyID == reply.ID {
					printLogs(body, false)
					return
				}
				printLogs(body, true)
			case <-timeout:
				slog.Warn("the function's output didn't arrive in time", "replyID", reply.ID)
				go func() { printLogs(<-read, true) }()
				return
			}
		case <-timeout:
			slog.Warn("the function's output didn't arrive in time", "replyID", reply.ID)
			return
		}
	}
}

const logsWait = 2 * time.Second

func readLogs(msg bridge.Message) bridge.LogsBody {
	var body bridge.LogsBody
	if err := json.NewDecoder(msg.Body).Decode(&body); err != nil {
		slog.Error("failed to read the function's output", "err", err)
	}
	return body
}

func printLogs(body bridge.LogsBody, late bool) {
	if late && (len(body.Lines) > 0 || body.Dropped > 0) {
		fmt.Printf("[sst dev] What an earlier invocation printed, which arrived late (%s):\n", body.ReplyID)
	}
	for _, line := range body.Lines {
		fmt.Println(line)
	}
	if body.Dropped > 0 {
		fmt.Printf("[sst dev] %d more lines were left out, over the limit for one invocation.\n", body.Dropped)
	}
}

// printError prints a function's error after what it printed, as Lambda's
// Node.js runtime does, when the CLI sends what the function printed.
func printError(reply bridge.Message, kind string, body []byte) {
	if !reply.LogsFollow {
		return
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, body); err != nil {
		compact.Reset()
		compact.Write(bytes.ReplaceAll(bytes.TrimSpace(body), []byte("\n"), []byte(" ")))
	}
	fmt.Printf("ERROR\t%s\t%s\n", kind, compact.String())
}

// deadlineOf reads when Lambda ends the invocation, from the response to a
// request for the next one.
func deadlineOf(resp *http.Response) time.Time {
	ms, err := strconv.ParseInt(resp.Header.Get("Lambda-Runtime-Deadline-Ms"), 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

// waitForSubscription publishes probes to the bridge's own channel until one
// comes back, so the CLI is only asked for anything once its reply can arrive.
// AppSync drops events that have no live subscriber, and after a Lambda freeze
// the websocket can be dead without any error. A new subscription can also miss
// events for a moment after subscribe_success.
func waitForSubscription(ctx context.Context, conn *appsync.Connection, client *bridge.Client, channel string) {
	sent := map[string]bool{}
	for attempt := 1; attempt <= 15; attempt++ {
		if attempt == 4 || attempt == 10 {
			slog.Warn("subscription is not delivering, reconnecting")
			reconnectCtx, cancelReconnect := context.WithTimeout(ctx, 5*time.Second)
			conn.Reconnect(reconnectCtx)
			cancelReconnect()
			sent = map[string]bool{}
		}
		probeID := id.Ascending()
		sent[probeID] = true
		writer := client.NewWriter(bridge.MessageProbe, channel)
		writer.SetID(probeID)
		writer.Close()
		wait := time.After(500 * time.Millisecond)
	drain:
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-client.Read():
				if msg.Type == bridge.MessageProbe && sent[msg.ID] {
					return
				}
			case <-wait:
				break drain
			}
		}
	}
	slog.Error("subscription never delivered a probe, continuing anyway")
}

// isPingFor says whether a ping is for the invocation sent as the message with
// nextID. sst dev pings while its worker runs the invocation, so a ping can
// arrive after the reply, and be read while the bridge waits on its next
// invocation. Taken for that one's, it would wait 15 minutes for a sst dev that
// isn't there.
func isPingFor(msg bridge.Message, nextID string) bool {
	return msg.Type == bridge.MessagePing && msg.ID == nextID
}
