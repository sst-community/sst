package provider

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"

	"github.com/aws/aws-sdk-go-v2/aws"
	appsyncSdk "github.com/aws/aws-sdk-go-v2/service/appsync"
	appsyncTypes "github.com/aws/aws-sdk-go-v2/service/appsync/types"
)

// AppSync is the Event API that sst dev and the stubs deployed in place of
// functions and tasks talk through.
type AppSync struct {
	Http     string
	Realtime string
	Arn      string
	// Shared is whether it's the one Event API, named sst, that every app and
	// stage in the account and region shares
	Shared bool
}

// AppSyncScope is who an Event API is for: the zero value is the shared one,
// and an app and stage are that stage's own.
type AppSyncScope struct {
	App   string
	Stage string
}

const (
	appsyncSharedName = "sst"
	appsyncNamespace  = "sst"
	appsyncTagApp     = "sst:app"
	appsyncTagStage   = "sst:stage"
	// every resource of an app has its app and stage tags, an Event API the
	// app deploys too, so the one sst dev made also has this one
	appsyncTagDev      = "sst:dev"
	appsyncTagDevValue = "appsync"
	// the longest name AppSync takes for an API
	appsyncNameMax = 50
)

// what of AppSync's control plane an Event API is found, created and removed
// with
type appsyncClient interface {
	ListApis(context.Context, *appsyncSdk.ListApisInput, ...func(*appsyncSdk.Options)) (*appsyncSdk.ListApisOutput, error)
	GetApi(context.Context, *appsyncSdk.GetApiInput, ...func(*appsyncSdk.Options)) (*appsyncSdk.GetApiOutput, error)
	CreateApi(context.Context, *appsyncSdk.CreateApiInput, ...func(*appsyncSdk.Options)) (*appsyncSdk.CreateApiOutput, error)
	CreateChannelNamespace(context.Context, *appsyncSdk.CreateChannelNamespaceInput, ...func(*appsyncSdk.Options)) (*appsyncSdk.CreateChannelNamespaceOutput, error)
	GetChannelNamespace(context.Context, *appsyncSdk.GetChannelNamespaceInput, ...func(*appsyncSdk.Options)) (*appsyncSdk.GetChannelNamespaceOutput, error)
	DeleteApi(context.Context, *appsyncSdk.DeleteApiInput, ...func(*appsyncSdk.Options)) (*appsyncSdk.DeleteApiOutput, error)
}

// ResolveAppSync finds the Event API for a scope, or creates it. The shared one
// is found by its name, and a stage's by its tags, as names needn't be unique
// and a stage's name can be cut short. An Event API the app deploys has the
// stage's tags too, but not sst:dev. Once found, it's kept for the process.
func (a *AwsProvider) ResolveAppSync(ctx context.Context, scope AppSyncScope) (*AppSync, error) {
	a.appsyncLock.Lock()
	defer a.appsyncLock.Unlock()
	if a.appsyncCache == nil {
		a.appsyncCache = map[AppSyncScope]*AppSync{}
	}
	if cached, ok := a.appsyncCache[scope]; ok {
		return cached, nil
	}
	result, err := resolveAppSync(ctx, a.appsyncClient(), scope)
	if err != nil {
		return nil, err
	}
	a.appsyncCache[scope] = result
	return result, nil
}

// RemoveAppSync removes a stage's own Event API, if it has one. The shared one
// is never removed.
func (a *AwsProvider) RemoveAppSync(ctx context.Context, app, stage string) error {
	if app == "" || stage == "" {
		return nil
	}
	scope := AppSyncScope{App: app, Stage: stage}
	a.appsyncLock.Lock()
	defer a.appsyncLock.Unlock()
	delete(a.appsyncCache, scope)
	return removeAppSync(ctx, a.appsyncClient(), scope)
}

func (a *AwsProvider) appsyncClient() appsyncClient {
	if a.appsync != nil {
		return a.appsync
	}
	return appsyncSdk.NewFromConfig(a.config)
}

func resolveAppSync(ctx context.Context, client appsyncClient, scope AppSyncScope) (*AppSync, error) {
	matches, err := findAppSync(ctx, client, scope)
	if err != nil {
		return nil, err
	}
	if len(matches) > 0 {
		// if there are two, as when two sst dev sessions for the stage both
		// created one, this and later runs use the oldest, and sst remove
		// removes both
		match, err := client.GetApi(ctx, &appsyncSdk.GetApiInput{ApiId: matches[0].ApiId})
		if err != nil {
			return nil, err
		}
		// only for a stage's, as the shared API's credentials needn't read
		// namespaces
		if scope != (AppSyncScope{}) {
			if err := ensureAppSyncNamespace(ctx, client, match.Api.ApiId); err != nil {
				return nil, err
			}
		}
		return appsyncResult(match.Api, scope), nil
	}
	return createAppSync(ctx, client, scope)
}

// findAppSync lists the Event APIs for a scope, the oldest first
func findAppSync(ctx context.Context, client appsyncClient, scope AppSyncScope) ([]appsyncTypes.Api, error) {
	var matches []appsyncTypes.Api
	var nextToken *string
	for {
		results, err := client.ListApis(ctx, &appsyncSdk.ListApisInput{
			NextToken: nextToken,
		})
		if err != nil {
			return nil, err
		}
		for _, result := range results.Apis {
			if appsyncMatches(result, scope) {
				matches = append(matches, result)
			}
		}
		if results.NextToken == nil {
			break
		}
		nextToken = results.NextToken
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return aws.ToTime(matches[i].Created).Before(aws.ToTime(matches[j].Created))
	})
	return matches, nil
}

func appsyncMatches(api appsyncTypes.Api, scope AppSyncScope) bool {
	if scope == (AppSyncScope{}) {
		return aws.ToString(api.Name) == appsyncSharedName
	}
	return api.Tags[appsyncTagDev] == appsyncTagDevValue &&
		api.Tags[appsyncTagApp] == scope.App &&
		api.Tags[appsyncTagStage] == scope.Stage
}

func createAppSync(ctx context.Context, client appsyncClient, scope AppSyncScope) (*AppSync, error) {
	authModes := appsyncAuthModes()
	input := &appsyncSdk.CreateApiInput{
		Name: aws.String(appsyncName(scope)),
		EventConfig: &appsyncTypes.EventConfig{
			AuthProviders: []appsyncTypes.AuthProvider{
				{AuthType: appsyncTypes.AuthenticationTypeAwsIam},
				{AuthType: appsyncTypes.AuthenticationTypeApiKey},
			},
			ConnectionAuthModes:       authModes,
			DefaultPublishAuthModes:   authModes,
			DefaultSubscribeAuthModes: authModes,
		},
	}
	if scope != (AppSyncScope{}) {
		input.Tags = map[string]string{
			appsyncTagApp:   scope.App,
			appsyncTagStage: scope.Stage,
			appsyncTagDev:   appsyncTagDevValue,
		}
	}
	api, err := client.CreateApi(ctx, input)
	if err != nil {
		return nil, err
	}
	err = createAppSyncNamespace(ctx, client, api.Api.ApiId)
	if err != nil {
		// an API without its namespace would be found again and not work, so
		// it goes, and the next sst dev creates it again
		if _, deleteErr := client.DeleteApi(ctx, &appsyncSdk.DeleteApiInput{ApiId: api.Api.ApiId}); deleteErr != nil {
			slog.Warn("failed to remove event api without its namespace", "api", aws.ToString(api.Api.ApiId), "err", deleteErr)
		}
		return nil, err
	}
	slog.Info("created appsync event api", "name", aws.ToString(api.Api.Name), "dns", api.Api.Dns)
	return appsyncResult(api.Api, scope), nil
}

// ensureAppSyncNamespace gives an Event API that was found its sst namespace,
// if it's without one, as when sst dev was stopped between creating the two
func ensureAppSyncNamespace(ctx context.Context, client appsyncClient, apiID *string) error {
	_, err := client.GetChannelNamespace(ctx, &appsyncSdk.GetChannelNamespaceInput{
		ApiId: apiID,
		Name:  aws.String(appsyncNamespace),
	})
	var notFound *appsyncTypes.NotFoundException
	if !errors.As(err, &notFound) {
		return err
	}
	slog.Info("creating the namespace of an appsync event api without one", "api", aws.ToString(apiID))
	return createAppSyncNamespace(ctx, client, apiID)
}

func createAppSyncNamespace(ctx context.Context, client appsyncClient, apiID *string) error {
	authModes := appsyncAuthModes()
	_, err := client.CreateChannelNamespace(ctx, &appsyncSdk.CreateChannelNamespaceInput{
		Name:               aws.String(appsyncNamespace),
		ApiId:              apiID,
		PublishAuthModes:   authModes,
		SubscribeAuthModes: authModes,
	})
	return err
}

func appsyncAuthModes() []appsyncTypes.AuthMode {
	return []appsyncTypes.AuthMode{
		{AuthType: appsyncTypes.AuthenticationTypeAwsIam},
		{AuthType: appsyncTypes.AuthenticationTypeApiKey},
	}
}

func removeAppSync(ctx context.Context, client appsyncClient, scope AppSyncScope) error {
	matches, err := findAppSync(ctx, client, scope)
	if err != nil {
		return err
	}
	for _, match := range matches {
		slog.Info("removing appsync event api", "name", aws.ToString(match.Name), "api", aws.ToString(match.ApiId))
		_, err := client.DeleteApi(ctx, &appsyncSdk.DeleteApiInput{ApiId: match.ApiId})
		var notFound *appsyncTypes.NotFoundException
		if err != nil && !errors.As(err, &notFound) {
			return err
		}
	}
	return nil
}

func appsyncResult(api *appsyncTypes.Api, scope AppSyncScope) *AppSync {
	return &AppSync{
		Http:     api.Dns["HTTP"],
		Realtime: api.Dns["REALTIME"],
		Arn:      aws.ToString(api.ApiArn),
		Shared:   scope == (AppSyncScope{}),
	}
}

var appsyncNameInvalid = regexp.MustCompile(`[^A-Za-z0-9_\- ]`)

// appsyncName names a stage's Event API sst-<app>-<stage>, for people reading
// the list of APIs. One too long for AppSync is cut short and ends in a hash of
// the whole, to tell it from another stage's.
func appsyncName(scope AppSyncScope) string {
	if scope == (AppSyncScope{}) {
		return appsyncSharedName
	}
	name := appsyncNameInvalid.ReplaceAllString(fmt.Sprintf("sst-%s-%s", scope.App, scope.Stage), "-")
	if len(name) <= appsyncNameMax {
		return name
	}
	sum := sha256.Sum256([]byte(scope.App + "\x00" + scope.Stage))
	hash := hex.EncodeToString(sum[:])[:8]
	return name[:appsyncNameMax-len(hash)-1] + "-" + hash
}
