package project

import (
	"strings"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
)

func makeProviderResource(provider string, version string) apitype.ResourceV3 {
	return apitype.ResourceV3{
		Type: tokens.Type("pulumi:providers:" + provider),
		Outputs: map[string]interface{}{
			"version": version,
		},
	}
}

func TestCheckProviderUpgrade_AWSV6ToV7(t *testing.T) {
	p := sst5(&Project{
		lock: ProviderLock{
			{Name: "aws", Package: "@pulumi/aws", Alias: "aws", Version: "7.0.0"},
		},
	})

	resources := []apitype.ResourceV3{
		makeProviderResource("aws", "6.52.0"),
	}

	messages := p.checkProviderUpgrade(resources)
	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}
	if !strings.Contains(messages[0], "AWS") {
		t.Fatalf("expected message to mention AWS, got: %s", messages[0])
	}
}

func TestCheckProviderUpgrade_AWSAlreadyOnV7(t *testing.T) {
	p := sst5(&Project{
		lock: ProviderLock{
			{Name: "aws", Package: "@pulumi/aws", Alias: "aws", Version: "7.0.0"},
		},
	})

	resources := []apitype.ResourceV3{
		makeProviderResource("aws", "7.0.0"),
	}

	messages := p.checkProviderUpgrade(resources)
	if len(messages) != 0 {
		t.Fatalf("expected 0 messages, got %d", len(messages))
	}
}

func TestCheckProviderUpgrade_NoMatchingProvider(t *testing.T) {
	p := sst5(&Project{
		lock: ProviderLock{
			{Name: "aws", Package: "@pulumi/aws", Alias: "aws", Version: "7.0.0"},
		},
	})

	resources := []apitype.ResourceV3{
		makeProviderResource("vercel", "1.11.0"),
	}

	messages := p.checkProviderUpgrade(resources)
	if len(messages) != 0 {
		t.Fatalf("expected 0 messages, got %d", len(messages))
	}
}

// Just after a refresh the state has the new provider first and the old one at
// the end. The first entry in the slice decides the version.
func TestCheckProviderUpgrade_FirstProviderEntryWins(t *testing.T) {
	p := sst5(&Project{
		lock: ProviderLock{
			{Name: "aws", Package: "@pulumi/aws", Alias: "aws", Version: "7.0.0"},
		},
	})

	newFirst := []apitype.ResourceV3{
		makeProviderResource("aws", "7.0.0"),
		makeProviderResource("aws", "6.52.0"),
	}
	if messages := p.checkProviderUpgrade(newFirst); len(messages) != 0 {
		t.Fatalf("new provider first: expected 0 messages, got %d", len(messages))
	}

	oldFirst := []apitype.ResourceV3{
		makeProviderResource("aws", "6.52.0"),
		makeProviderResource("aws", "7.0.0"),
	}
	if messages := p.checkProviderUpgrade(oldFirst); len(messages) != 1 {
		t.Fatalf("old provider first: expected 1 message, got %d", len(messages))
	}
}

func TestCheckProviderUpgrade_SkipsNonProvidersAndMissingVersions(t *testing.T) {
	p := sst5(&Project{
		lock: ProviderLock{
			{Name: "aws", Package: "@pulumi/aws", Alias: "aws", Version: "7.0.0"},
		},
	})

	resources := []apitype.ResourceV3{
		{Type: tokens.Type("aws:s3/bucket:Bucket"), Outputs: map[string]interface{}{"version": "6.0.0"}},
		{Type: tokens.Type("pulumi:providers:aws"), Outputs: map[string]interface{}{"version": 6}},
		{Type: tokens.Type("pulumi:providers:aws"), Outputs: map[string]interface{}{}},
		makeProviderResource("aws", "6.52.0"),
	}
	if messages := p.checkProviderUpgrade(resources); len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}
}

func TestCheckProviderUpgrade_EmptyResources(t *testing.T) {
	p := sst5(&Project{
		lock: ProviderLock{
			{Name: "aws", Package: "@pulumi/aws", Alias: "aws", Version: "7.0.0"},
		},
	})

	for _, resources := range [][]apitype.ResourceV3{nil, {}} {
		if messages := p.checkProviderUpgrade(resources); messages != nil {
			t.Fatalf("expected nil messages, got %v", messages)
		}
	}
}
