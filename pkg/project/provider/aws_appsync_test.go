package provider

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	appsyncSdk "github.com/aws/aws-sdk-go-v2/service/appsync"
	appsyncTypes "github.com/aws/aws-sdk-go-v2/service/appsync/types"
)

// fakeAppSync is AppSync's control plane, with its APIs in memory
type fakeAppSync struct {
	lock       sync.Mutex
	apis       []appsyncTypes.Api
	namespaces map[string][]string
	pageSize   int
	created    int
	deleted    []string
	// failNamespace fails CreateChannelNamespace
	failNamespace bool
	// listDelay slows ListApis, so concurrent callers overlap
	listDelay time.Duration
	next      int
}

func (f *fakeAppSync) add(name string, tags map[string]string, created time.Time) string {
	f.next++
	id := fmt.Sprintf("api%d", f.next)
	f.apis = append(f.apis, appsyncTypes.Api{
		ApiId:   aws.String(id),
		ApiArn:  aws.String("arn:aws:appsync:ca-central-1:123456789012:apis/" + id),
		Name:    aws.String(name),
		Tags:    tags,
		Created: aws.Time(created),
	})
	return id
}

func (f *fakeAppSync) ListApis(ctx context.Context, in *appsyncSdk.ListApisInput, _ ...func(*appsyncSdk.Options)) (*appsyncSdk.ListApisOutput, error) {
	time.Sleep(f.listDelay)
	f.lock.Lock()
	defer f.lock.Unlock()
	start := 0
	if in.NextToken != nil {
		fmt.Sscanf(*in.NextToken, "%d", &start)
	}
	size := f.pageSize
	if size == 0 {
		size = len(f.apis) + 1
	}
	end := min(start+size, len(f.apis))
	out := &appsyncSdk.ListApisOutput{}
	for _, api := range f.apis[start:end] {
		// ListApis gives no endpoints, as AppSync's doesn't
		api.Dns = nil
		out.Apis = append(out.Apis, api)
	}
	if end < len(f.apis) {
		out.NextToken = aws.String(fmt.Sprint(end))
	}
	return out, nil
}

func (f *fakeAppSync) GetApi(ctx context.Context, in *appsyncSdk.GetApiInput, _ ...func(*appsyncSdk.Options)) (*appsyncSdk.GetApiOutput, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	for _, api := range f.apis {
		if *api.ApiId == *in.ApiId {
			api.Dns = map[string]string{"HTTP": *api.ApiId + ".http", "REALTIME": *api.ApiId + ".realtime"}
			return &appsyncSdk.GetApiOutput{Api: &api}, nil
		}
	}
	return nil, &appsyncTypes.NotFoundException{}
}

func (f *fakeAppSync) CreateApi(ctx context.Context, in *appsyncSdk.CreateApiInput, _ ...func(*appsyncSdk.Options)) (*appsyncSdk.CreateApiOutput, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	if len(*in.Name) > appsyncNameMax {
		return nil, errors.New("name too long")
	}
	f.created++
	id := f.add(*in.Name, in.Tags, time.Now())
	api := f.apis[len(f.apis)-1]
	api.Dns = map[string]string{"HTTP": id + ".http", "REALTIME": id + ".realtime"}
	return &appsyncSdk.CreateApiOutput{Api: &api}, nil
}

func (f *fakeAppSync) CreateChannelNamespace(ctx context.Context, in *appsyncSdk.CreateChannelNamespaceInput, _ ...func(*appsyncSdk.Options)) (*appsyncSdk.CreateChannelNamespaceOutput, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	if f.failNamespace {
		return nil, errors.New("namespace failed")
	}
	if f.namespaces == nil {
		f.namespaces = map[string][]string{}
	}
	f.namespaces[*in.ApiId] = append(f.namespaces[*in.ApiId], *in.Name)
	return &appsyncSdk.CreateChannelNamespaceOutput{}, nil
}

func (f *fakeAppSync) GetChannelNamespace(ctx context.Context, in *appsyncSdk.GetChannelNamespaceInput, _ ...func(*appsyncSdk.Options)) (*appsyncSdk.GetChannelNamespaceOutput, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	for _, name := range f.namespaces[*in.ApiId] {
		if name == *in.Name {
			return &appsyncSdk.GetChannelNamespaceOutput{ChannelNamespace: &appsyncTypes.ChannelNamespace{Name: in.Name}}, nil
		}
	}
	return nil, &appsyncTypes.NotFoundException{}
}

func (f *fakeAppSync) DeleteApi(ctx context.Context, in *appsyncSdk.DeleteApiInput, _ ...func(*appsyncSdk.Options)) (*appsyncSdk.DeleteApiOutput, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	for i, api := range f.apis {
		if *api.ApiId == *in.ApiId {
			f.apis = append(f.apis[:i], f.apis[i+1:]...)
			f.deleted = append(f.deleted, *in.ApiId)
			return &appsyncSdk.DeleteApiOutput{}, nil
		}
	}
	return nil, &appsyncTypes.NotFoundException{}
}

func stageTags(app, stage string) map[string]string {
	return map[string]string{appsyncTagApp: app, appsyncTagStage: stage, appsyncTagDev: appsyncTagDevValue}
}

// appTags are the tags the provider puts on every resource of an app, which
// an Event API the app itself deploys has
func appTags(app, stage string) map[string]string {
	return map[string]string{appsyncTagApp: app, appsyncTagStage: stage}
}

var stage = AppSyncScope{App: "my-app", Stage: "alice"}

func TestResolveAppSyncSharedFindsTheApiNamedSst(t *testing.T) {
	now := time.Now()
	fake := &fakeAppSync{pageSize: 1}
	fake.add("other", nil, now)
	fake.add("sst-my-app-alice", stageTags("my-app", "alice"), now)
	shared := fake.add("sst", nil, now)

	got, err := resolveAppSync(context.Background(), fake, AppSyncScope{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Http != shared+".http" || got.Realtime != shared+".realtime" || !got.Shared {
		t.Fatalf("got %+v, want the shared api %s", got, shared)
	}
	if fake.created != 0 {
		t.Fatalf("created %d apis, want none", fake.created)
	}
}

func TestResolveAppSyncSharedCreatesItUntagged(t *testing.T) {
	fake := &fakeAppSync{}
	fake.add("sst-my-app-alice", stageTags("my-app", "alice"), time.Now())

	got, err := resolveAppSync(context.Background(), fake, AppSyncScope{})
	if err != nil {
		t.Fatal(err)
	}
	api := fake.apis[len(fake.apis)-1]
	if *api.Name != "sst" || len(api.Tags) != 0 {
		t.Fatalf("created %q with tags %v, want sst untagged", *api.Name, api.Tags)
	}
	if ns := fake.namespaces[*api.ApiId]; len(ns) != 1 || ns[0] != "sst" {
		t.Fatalf("namespaces %v, want [sst]", ns)
	}
	if !got.Shared || got.Arn != *api.ApiArn {
		t.Fatalf("got %+v", got)
	}
}

func TestResolveAppSyncStageFindsItsOwnByTags(t *testing.T) {
	now := time.Now()
	fake := &fakeAppSync{pageSize: 2}
	fake.add("sst", nil, now)
	// the same name, but another app's stage: app my-app-alice, stage x
	fake.add("sst-my-app-alice", stageTags("my", "app-alice"), now)
	fake.add("sst-my-app-bob", stageTags("my-app", "bob"), now)
	// the app's own Event API, which has the app's tags, and is older
	fake.add("my-app-alice-events", appTags("my-app", "alice"), now.Add(-time.Hour))
	own := fake.add("renamed by hand", stageTags("my-app", "alice"), now)

	got, err := resolveAppSync(context.Background(), fake, stage)
	if err != nil {
		t.Fatal(err)
	}
	if got.Http != own+".http" || got.Shared {
		t.Fatalf("got %+v, want the stage's api %s", got, own)
	}
	if got.Arn != "arn:aws:appsync:ca-central-1:123456789012:apis/"+own {
		t.Fatalf("arn %q", got.Arn)
	}
	if fake.created != 0 {
		t.Fatalf("created %d apis, want none", fake.created)
	}
}

func TestResolveAppSyncStageCreatesItTagged(t *testing.T) {
	fake := &fakeAppSync{}
	fake.add("sst", nil, time.Now())

	got, err := resolveAppSync(context.Background(), fake, stage)
	if err != nil {
		t.Fatal(err)
	}
	api := fake.apis[len(fake.apis)-1]
	if *api.Name != "sst-my-app-alice" {
		t.Fatalf("name %q", *api.Name)
	}
	if api.Tags[appsyncTagApp] != "my-app" || api.Tags[appsyncTagStage] != "alice" || api.Tags[appsyncTagDev] != appsyncTagDevValue {
		t.Fatalf("tags %v", api.Tags)
	}
	if ns := fake.namespaces[*api.ApiId]; len(ns) != 1 || ns[0] != "sst" {
		t.Fatalf("namespaces %v, want [sst]", ns)
	}
	if got.Shared || got.Http != *api.ApiId+".http" {
		t.Fatalf("got %+v", got)
	}

	// and finds it the next time
	again, err := resolveAppSync(context.Background(), fake, stage)
	if err != nil {
		t.Fatal(err)
	}
	if again.Arn != got.Arn || fake.created != 1 {
		t.Fatalf("found %+v after creating %d", again, fake.created)
	}
}

// A stage's API left without its namespace, as by an sst dev that was stopped
// between creating the two, gets it when it's found.
func TestResolveAppSyncGivesAStagesApiItsNamespace(t *testing.T) {
	fake := &fakeAppSync{}
	id := fake.add(appsyncName(stage), stageTags(stage.App, stage.Stage), time.Now())

	if _, err := resolveAppSync(context.Background(), fake, stage); err != nil {
		t.Fatal(err)
	}
	if ns := fake.namespaces[id]; len(ns) != 1 || ns[0] != "sst" {
		t.Fatalf("namespaces %v, want [sst]", ns)
	}
	// and one that has it isn't given another
	if _, err := resolveAppSync(context.Background(), fake, stage); err != nil {
		t.Fatal(err)
	}
	if ns := fake.namespaces[id]; len(ns) != 1 {
		t.Fatalf("namespaces %v after finding it again", ns)
	}
	if fake.created != 0 {
		t.Fatalf("created %d apis", fake.created)
	}
}

// The shared API's namespace isn't looked at, as its credentials needn't
// reach it, and that's as before.
func TestResolveAppSyncSharedDoesNotTouchItsNamespace(t *testing.T) {
	fake := &fakeAppSync{}
	id := fake.add("sst", nil, time.Now())
	if _, err := resolveAppSync(context.Background(), fake, AppSyncScope{}); err != nil {
		t.Fatal(err)
	}
	if ns := fake.namespaces[id]; len(ns) != 0 {
		t.Fatalf("namespaces %v, want none made", ns)
	}
}

func TestResolveAppSyncStageUsesTheOldestOfTwo(t *testing.T) {
	now := time.Now()
	fake := &fakeAppSync{}
	fake.add("sst-my-app-alice", stageTags("my-app", "alice"), now)
	oldest := fake.add("sst-my-app-alice", stageTags("my-app", "alice"), now.Add(-time.Minute))

	got, err := resolveAppSync(context.Background(), fake, stage)
	if err != nil {
		t.Fatal(err)
	}
	if got.Http != oldest+".http" {
		t.Fatalf("got %+v, want the oldest %s", got, oldest)
	}
}

func TestResolveAppSyncRemovesAnApiWithoutItsNamespace(t *testing.T) {
	fake := &fakeAppSync{failNamespace: true}
	if _, err := resolveAppSync(context.Background(), fake, stage); err == nil {
		t.Fatal("want the namespace's error")
	}
	if len(fake.apis) != 0 || len(fake.deleted) != 1 {
		t.Fatalf("apis %d, deleted %v: want the api removed", len(fake.apis), fake.deleted)
	}

	fake.failNamespace = false
	if _, err := resolveAppSync(context.Background(), fake, stage); err != nil {
		t.Fatal(err)
	}
	if fake.created != 2 {
		t.Fatalf("created %d, want it created again", fake.created)
	}
}

func TestResolveAppSyncCreatesOneForConcurrentCallers(t *testing.T) {
	fake := &fakeAppSync{listDelay: 10 * time.Millisecond}
	p := &AwsProvider{appsync: fake}

	var wg sync.WaitGroup
	results := make([]*AppSync, 20)
	errs := make([]error, 20)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = p.ResolveAppSync(context.Background(), stage)
		}()
	}
	wg.Wait()
	for i := range results {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if results[i].Arn != results[0].Arn {
			t.Fatalf("caller %d got %s, caller 0 %s", i, results[i].Arn, results[0].Arn)
		}
	}
	if fake.created != 1 {
		t.Fatalf("created %d apis, want 1", fake.created)
	}
}

func TestResolveAppSyncKeepsTheSharedAndStageApart(t *testing.T) {
	fake := &fakeAppSync{}
	p := &AwsProvider{appsync: fake}
	shared, err := p.ResolveAppSync(context.Background(), AppSyncScope{})
	if err != nil {
		t.Fatal(err)
	}
	own, err := p.ResolveAppSync(context.Background(), stage)
	if err != nil {
		t.Fatal(err)
	}
	if shared.Arn == own.Arn || !shared.Shared || own.Shared {
		t.Fatalf("shared %+v, stage %+v", shared, own)
	}
}

func TestRemoveAppSyncRemovesOnlyTheStagesOwn(t *testing.T) {
	now := time.Now()
	fake := &fakeAppSync{pageSize: 1}
	shared := fake.add("sst", nil, now)
	bob := fake.add("sst-my-app-bob", stageTags("my-app", "bob"), now)
	other := fake.add("sst-my-app-alice", stageTags("my", "app-alice"), now)
	appOwn := fake.add("my-app-alice-events", appTags("my-app", "alice"), now)
	own1 := fake.add("sst-my-app-alice", stageTags("my-app", "alice"), now)
	own2 := fake.add("sst-my-app-alice", stageTags("my-app", "alice"), now.Add(time.Second))
	p := &AwsProvider{appsync: fake}
	if _, err := p.ResolveAppSync(context.Background(), stage); err != nil {
		t.Fatal(err)
	}

	if err := p.RemoveAppSync(context.Background(), "my-app", "alice"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(fake.deleted, ",") != own1+","+own2 {
		t.Fatalf("deleted %v, want %s and %s", fake.deleted, own1, own2)
	}
	var left []string
	for _, api := range fake.apis {
		left = append(left, *api.ApiId)
	}
	if strings.Join(left, ",") != strings.Join([]string{shared, bob, other, appOwn}, ",") {
		t.Fatalf("left %v", left)
	}

	// it's forgotten, so the next sst dev creates it again
	if _, err := p.ResolveAppSync(context.Background(), stage); err != nil {
		t.Fatal(err)
	}
	if fake.created != 1 {
		t.Fatalf("created %d, want it created again", fake.created)
	}
}

func TestRemoveAppSyncWithoutOne(t *testing.T) {
	fake := &fakeAppSync{}
	fake.add("sst", nil, time.Now())
	p := &AwsProvider{appsync: fake}
	if err := p.RemoveAppSync(context.Background(), "my-app", "alice"); err != nil {
		t.Fatal(err)
	}
	if len(fake.deleted) != 0 {
		t.Fatalf("deleted %v", fake.deleted)
	}
}

func TestAppSyncName(t *testing.T) {
	if got := appsyncName(AppSyncScope{}); got != "sst" {
		t.Fatalf("shared %q", got)
	}
	if got := appsyncName(stage); got != "sst-my-app-alice" {
		t.Fatalf("got %q", got)
	}
	if got := appsyncName(AppSyncScope{App: "app", Stage: "pr.12/x"}); got != "sst-app-pr-12-x" {
		t.Fatalf("got %q", got)
	}
	long := strings.Repeat("a", 40)
	a := appsyncName(AppSyncScope{App: long, Stage: "stage-one"})
	b := appsyncName(AppSyncScope{App: long, Stage: "stage-two"})
	if len(a) != appsyncNameMax || len(b) != appsyncNameMax || a == b {
		t.Fatalf("long names %q and %q", a, b)
	}
	if !appsyncNameValid(a) {
		t.Fatalf("%q isn't a valid name", a)
	}
}

func appsyncNameValid(name string) bool {
	return !appsyncNameInvalid.MatchString(name) && len(name) <= appsyncNameMax
}

// RemoveAppSync is for a stage's own API, so an empty app or stage, which is
// the shared API's scope, removes nothing.
func TestRemoveAppSyncNeverRemovesTheShared(t *testing.T) {
	fake := &fakeAppSync{}
	fake.add("sst", nil, time.Now())
	p := &AwsProvider{appsync: fake}
	for _, args := range [][2]string{{"", ""}, {"my-app", ""}, {"", "alice"}} {
		if err := p.RemoveAppSync(context.Background(), args[0], args[1]); err != nil {
			t.Fatal(err)
		}
	}
	if len(fake.deleted) != 0 {
		t.Fatalf("deleted %v", fake.deleted)
	}
}
