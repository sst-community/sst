package provider

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/route53"
	"github.com/aws/aws-sdk-go-v2/service/route53/types"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	pulumirpc "github.com/pulumi/pulumi/sdk/v3/proto/go"
)

// function is one of the provider's functions: a lookup the program makes
// while it runs, a preview's run too, so what it finds is known before
// anything is created. SST 4 made these resources, which a new stage's
// preview couldn't run (docs/plans/v5-rewrite/reference.md, SST's provider
// resources).
type function func(ctx context.Context, args resource.PropertyMap) (resource.PropertyMap, error)

// functions are the provider's functions, by token, with the AWS setup load
// gives.
func functions(load func() (aws.Config, error)) map[string]function {
	zones := &hostedZones{load: load}
	return map[string]function{
		// The id of the Route 53 hosted zone a domain is in (pickZone)
		"sst:aws:getHostedZone": func(ctx context.Context, args resource.PropertyMap) (resource.PropertyMap, error) {
			var input struct {
				Domain string `json:"domain"`
			}
			if err := decode(args, &input); err != nil {
				return nil, err
			}
			if input.Domain == "" {
				return nil, fmt.Errorf("sst:aws:getHostedZone needs a domain")
			}
			list, err := zones.list(ctx)
			if err != nil {
				return nil, err
			}
			zoneID, err := pickZone(list, input.Domain)
			if err != nil {
				return nil, err
			}
			return resource.NewPropertyMapFromMap(map[string]any{"zoneId": zoneID}), nil
		},
	}
}

// hostedZones are the account's hosted zones, listed once for the provider's
// run: a program looks one up for each DNS record, in each preview and
// deploy, and Route 53 allows a few calls a second.
type hostedZones struct {
	load  func() (aws.Config, error)
	once  sync.Once
	zones []types.HostedZone
	err   error
}

func (h *hostedZones) list(ctx context.Context) ([]types.HostedZone, error) {
	h.once.Do(func() {
		cfg, err := h.load()
		if err != nil {
			h.err = err
			return
		}
		paginator := route53.NewListHostedZonesPaginator(route53.NewFromConfig(cfg), &route53.ListHostedZonesInput{})
		for paginator.HasMorePages() {
			page, err := paginator.NextPage(ctx)
			if err != nil {
				h.err = fmt.Errorf("listing the hosted zones: %w", err)
				return
			}
			h.zones = append(h.zones, page.HostedZones...)
		}
	})
	return h.zones, h.err
}

// pickZone is the id of the hosted zone a domain is in: the one whose name is
// the longest the domain ends with. Of zones with that name, a public one is
// taken over a private one. Two of the same kind are refused rather than
// guessed between, so the zone a record is in never changes because a zone was
// added: the adapter's `zone` says which.
//
// SST 4's lookup took the first zone Route 53 listed with that name, and kept
// it in the state, so it didn't look again.
func pickZone(zones []types.HostedZone, domain string) (string, error) {
	labels := strings.Split(strings.TrimSuffix(domain, "."), ".")
	for i := 0; i <= len(labels)-2; i++ {
		name := strings.Join(labels[i:], ".") + "."
		var public, private []types.HostedZone
		for _, zone := range zones {
			if !strings.EqualFold(aws.ToString(zone.Name), name) {
				continue
			}
			if zone.Config != nil && zone.Config.PrivateZone {
				private = append(private, zone)
			} else {
				public = append(public, zone)
			}
		}
		found := public
		if len(found) == 0 {
			found = private
		}
		switch len(found) {
		case 0:
			continue
		case 1:
			return strings.TrimPrefix(aws.ToString(found[0].Id), "/hostedzone/"), nil
		default:
			return "", fmt.Errorf("there are %d hosted zones named %s for %s: give sst.aws.dns() the one to use, as its `zone`", len(found), strings.TrimSuffix(name, "."), domain)
		}
	}
	return "", fmt.Errorf("could not find hosted zone for domain %s", domain)
}

// Invoke runs one of the provider's functions
func (s *server) Invoke(ctx context.Context, req *pulumirpc.InvokeRequest) (*pulumirpc.InvokeResponse, error) {
	fn, ok := s.functions[req.GetTok()]
	if !ok {
		return nil, fmt.Errorf("the sst provider has no function %q", req.GetTok())
	}
	args, err := unmarshal(req.GetArgs())
	if err != nil {
		return nil, err
	}
	// The program waits for its arguments before it calls, so none is unknown
	if args.ContainsUnknowns() {
		return nil, fmt.Errorf("%s was called with a value that isn't known yet", req.GetTok())
	}
	result, err := fn(ctx, args)
	if err != nil {
		return nil, err
	}
	properties, err := marshal(result)
	if err != nil {
		return nil, err
	}
	return &pulumirpc.InvokeResponse{Return: properties}, nil
}
