// Package provider is the Pulumi provider the sst binary serves for SST's own
// resources, the package `sst` (docs/plans/v5-rewrite/plan.md, Decisions,
// 2026-11-01). Pulumi runs it as it runs any provider: the CLI names its own
// binary as the package's plugin in the work folder's Pulumi.yaml
// (pkg/project), and the binary serves this when it's run by the plugin's
// name (cmd/sst/main.go). Each resource does its work here, with the code the
// CLI's RPC serves the old entries with (pkg/server/resource).
//
// The stage's setup comes from the environment Pulumi gives every plugin,
// which the CLI fills (aws.go), never from the provider's config: the state
// keeps that.
package provider

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"time"

	"github.com/Masterminds/semver/v3"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/plugin"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/cmdutil"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/logging"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/rpcutil"
	pulumirpc "github.com/pulumi/pulumi/sdk/v3/proto/go"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/structpb"
)

// Package is the name of the Pulumi package SST's own resources are in. Their
// types are `sst:<cloud>:<Resource>`.
const Package = "sst"

// Executable is the name Pulumi runs the package's plugin by. The sst binary
// serves the provider when it's run by this name.
const Executable = "pulumi-resource-" + Package

// Main serves the provider to the Pulumi engine that started it, until the
// engine is done with it. It does what Pulumi's provider.Main does
// (sdk/go/pulumi/provider), less its OpenTelemetry bridge: that's a module the
// CLI doesn't have, and Pulumi only uses it when asked to trace.
func Main(version string) error {
	// The engine's arguments: glog's logging flags, which Pulumi's logging
	// registers globally, --tracing, and the engine's address
	tracing := flag.String("tracing", "", "Emit tracing to a Zipkin-compatible tracing endpoint")
	flag.Parse()
	logging.InitLogging(false, 0, false)
	cmdutil.InitTracing(Package, Package, *tracing)

	// The engine sends an interrupt when it's done with the provider
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	switch args := flag.Args(); len(args) {
	case 0:
		// Started on its own, for the engine to attach to
	case 1:
		// Stop when the engine does
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		if err := rpcutil.Healthcheck(ctx, args[0], 5*time.Minute, cancel); err != nil {
			return fmt.Errorf("could not start health check host RPC server: %w", err)
		}
	default:
		return errors.New("fatal: could not connect to host RPC; too many arguments")
	}
	stop := make(chan bool)
	go func() {
		<-ctx.Done()
		close(stop)
	}()

	s := newServer(version, resources(envAws()))
	handle, err := rpcutil.ServeWithOptions(rpcutil.ServeOptions{
		Cancel: stop,
		Init: func(srv *grpc.Server) error {
			pulumirpc.RegisterResourceProviderServer(srv, s)
			return nil
		},
		Options: rpcutil.OpenTracingServerInterceptorOptions(nil),
	})
	if err != nil {
		return fmt.Errorf("fatal: %w", err)
	}
	// The engine reads the port from the first line of stdout, so nothing else
	// may print there
	fmt.Printf("%d\n", handle.Port)
	if err := <-handle.Done; err != nil {
		return fmt.Errorf("fatal: %w", err)
	}
	return nil
}

type server struct {
	pulumirpc.UnimplementedResourceProviderServer
	version   string
	resources map[string]handler
}

// newServer serves resources, by type. A version that isn't one Pulumi can
// read, as a dev build's isn't, is left out: the engine fails to load a
// plugin whose version it can't parse.
func newServer(version string, resources map[string]handler) *server {
	s := &server{resources: resources}
	if parsed, err := semver.NewVersion(version); err == nil {
		s.version = parsed.String()
	}
	return s
}

// handler is the resource of the type a URN names
func (s *server) handler(urn string) (handler, error) {
	typ := string(resource.URN(urn).Type())
	h, ok := s.resources[typ]
	if !ok {
		return nil, fmt.Errorf("the sst provider has no resource of type %q", typ)
	}
	return h, nil
}

func (s *server) GetPluginInfo(context.Context, *emptypb.Empty) (*pulumirpc.PluginInfo, error) {
	return &pulumirpc.PluginInfo{Version: s.version}, nil
}

// GetSchema is the package's name and version only. Nothing generates an SDK
// from it: the platform declares the resources itself.
func (s *server) GetSchema(context.Context, *pulumirpc.GetSchemaRequest) (*pulumirpc.GetSchemaResponse, error) {
	schema := fmt.Sprintf(`{"name":%q}`, Package)
	if s.version != "" {
		schema = fmt.Sprintf(`{"name":%q,"version":%q}`, Package, s.version)
	}
	return &pulumirpc.GetSchemaResponse{Schema: schema}, nil
}

// CheckConfig takes the config as it is. The provider reads none of it.
func (s *server) CheckConfig(_ context.Context, req *pulumirpc.CheckRequest) (*pulumirpc.CheckResponse, error) {
	return &pulumirpc.CheckResponse{Inputs: req.GetNews()}, nil
}

// DiffConfig never changes anything, so the provider is never replaced and
// takes no resource with it
func (s *server) DiffConfig(context.Context, *pulumirpc.DiffRequest) (*pulumirpc.DiffResponse, error) {
	return &pulumirpc.DiffResponse{Changes: pulumirpc.DiffResponse_DIFF_NONE}, nil
}

// Configure asks for plain values. With no preview support, the engine
// doesn't call Create or Update in a preview: it shows the inputs as the
// outputs.
func (s *server) Configure(context.Context, *pulumirpc.ConfigureRequest) (*pulumirpc.ConfigureResponse, error) {
	return &pulumirpc.ConfigureResponse{
		AcceptSecrets:   false,
		SupportsPreview: false,
		AcceptResources: false,
		AcceptOutputs:   false,
	}, nil
}

// Check takes the inputs as they are, unknowns in a preview too
func (s *server) Check(_ context.Context, req *pulumirpc.CheckRequest) (*pulumirpc.CheckResponse, error) {
	if _, err := s.handler(req.GetUrn()); err != nil {
		return nil, err
	}
	return &pulumirpc.CheckResponse{Inputs: req.GetNews()}, nil
}

// Diff compares the inputs the resource was last given with the new ones,
// each top-level property as the resource reads it. A property that isn't
// known yet, in a preview, counts as changed. A change is always an update in
// place: the resource's own Update decides what to do with it.
func (s *server) Diff(_ context.Context, req *pulumirpc.DiffRequest) (*pulumirpc.DiffResponse, error) {
	h, err := s.handler(req.GetUrn())
	if err != nil {
		return nil, err
	}
	// An engine that doesn't send the old inputs gives only the outputs, which
	// leave out what's empty; the typed inputs fill it in again (handler.diff)
	old := req.GetOldInputs()
	if old == nil {
		old = req.GetOlds()
	}
	olds, err := unmarshal(old)
	if err != nil {
		return nil, err
	}
	news, err := unmarshal(req.GetNews())
	if err != nil {
		return nil, err
	}
	changed, err := h.diff(olds, news)
	if err != nil {
		return nil, err
	}
	sort.Strings(changed)
	resp := &pulumirpc.DiffResponse{
		Changes:         pulumirpc.DiffResponse_DIFF_NONE,
		DetailedDiff:    map[string]*pulumirpc.PropertyDiff{},
		HasDetailedDiff: true,
	}
	if len(changed) > 0 {
		resp.Changes = pulumirpc.DiffResponse_DIFF_SOME
		resp.Diffs = changed
		for _, key := range changed {
			resp.DetailedDiff[key] = &pulumirpc.PropertyDiff{Kind: pulumirpc.PropertyDiff_UPDATE, InputDiff: true}
		}
	}
	return resp, nil
}

func (s *server) Create(ctx context.Context, req *pulumirpc.CreateRequest) (*pulumirpc.CreateResponse, error) {
	h, err := s.handler(req.GetUrn())
	if err != nil {
		return nil, err
	}
	// The engine doesn't ask in a preview (Configure), but if it does, nothing
	// is done
	if req.GetPreview() {
		return &pulumirpc.CreateResponse{Properties: req.GetProperties()}, nil
	}
	inputs, err := unmarshal(req.GetProperties())
	if err != nil {
		return nil, err
	}
	id, outs, err := h.create(ctx, inputs)
	if err != nil {
		return nil, err
	}
	properties, err := marshal(outs)
	if err != nil {
		return nil, err
	}
	return &pulumirpc.CreateResponse{Id: id, Properties: properties}, nil
}

// Read gives back what it's given, as SST's dynamic resources do: nothing
// they make can be read from the cloud as it was given.
func (s *server) Read(_ context.Context, req *pulumirpc.ReadRequest) (*pulumirpc.ReadResponse, error) {
	if _, err := s.handler(req.GetUrn()); err != nil {
		return nil, err
	}
	return &pulumirpc.ReadResponse{
		Id:         req.GetId(),
		Properties: req.GetProperties(),
		Inputs:     req.GetInputs(),
	}, nil
}

func (s *server) Update(ctx context.Context, req *pulumirpc.UpdateRequest) (*pulumirpc.UpdateResponse, error) {
	h, err := s.handler(req.GetUrn())
	if err != nil {
		return nil, err
	}
	if req.GetPreview() {
		return &pulumirpc.UpdateResponse{Properties: req.GetNews()}, nil
	}
	olds, err := unmarshal(req.GetOlds())
	if err != nil {
		return nil, err
	}
	news, err := unmarshal(req.GetNews())
	if err != nil {
		return nil, err
	}
	outs, err := h.update(ctx, req.GetId(), olds, news)
	if err != nil {
		return nil, err
	}
	properties, err := marshal(outs)
	if err != nil {
		return nil, err
	}
	return &pulumirpc.UpdateResponse{Properties: properties}, nil
}

func (s *server) Delete(ctx context.Context, req *pulumirpc.DeleteRequest) (*emptypb.Empty, error) {
	h, err := s.handler(req.GetUrn())
	if err != nil {
		return nil, err
	}
	outs, err := unmarshal(req.GetProperties())
	if err != nil {
		return nil, err
	}
	if err := h.delete(ctx, req.GetId(), outs); err != nil {
		return nil, err
	}
	return &emptypb.Empty{}, nil
}

// Cancel has nothing to stop: each call ends with its request
func (s *server) Cancel(context.Context, *emptypb.Empty) (*emptypb.Empty, error) {
	return &emptypb.Empty{}, nil
}

// unmarshal is Pulumi's properties as plain values. Unknowns are kept, for
// Diff to see; nothing else gets any, as the provider has no preview.
func unmarshal(props *structpb.Struct) (resource.PropertyMap, error) {
	return plugin.UnmarshalProperties(props, plugin.MarshalOptions{KeepUnknowns: true})
}

func marshal(props resource.PropertyMap) (*structpb.Struct, error) {
	return plugin.MarshalProperties(props, plugin.MarshalOptions{})
}
