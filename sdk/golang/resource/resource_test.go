package resource

import (
	"os"
	"testing"
)

func resetResources() {
	resources = make(map[string]any)
}

func TestKeys_LoadsSSTResourcesJSON(t *testing.T) {
	resetResources()
	os.Setenv("SST_RESOURCES_JSON", `{"MyBucket":{"name":"my-bucket"},"App":{"name":"app","stage":"dev"}}`)
	defer os.Unsetenv("SST_RESOURCES_JSON")

	loadFromEnv()

	val, err := Get("MyBucket", "name")
	if err != nil {
		t.Fatalf("expected MyBucket.name to exist: %v", err)
	}
	if val != "my-bucket" {
		t.Fatalf("expected MyBucket.name = my-bucket, got %v", val)
	}
}

func TestKeys_MergesSSTResourcesJSONWithIndividualVars(t *testing.T) {
	resetResources()
	os.Setenv("SST_RESOURCE_MyTable", `{"name":"my-table"}`)
	os.Setenv("SST_RESOURCES_JSON", `{"MyBucket":{"name":"my-bucket"}}`)
	defer os.Unsetenv("SST_RESOURCE_MyTable")
	defer os.Unsetenv("SST_RESOURCES_JSON")

	loadFromEnv()

	val1, err := Get("MyTable", "name")
	if err != nil {
		t.Fatalf("expected MyTable.name to exist: %v", err)
	}
	if val1 != "my-table" {
		t.Fatalf("expected MyTable.name = my-table, got %v", val1)
	}

	val2, err := Get("MyBucket", "name")
	if err != nil {
		t.Fatalf("expected MyBucket.name to exist: %v", err)
	}
	if val2 != "my-bucket" {
		t.Fatalf("expected MyBucket.name = my-bucket, got %v", val2)
	}
}

func TestKeys_SSTResourcesJSONOverridesIndividualVars(t *testing.T) {
	resetResources()
	os.Setenv("SST_RESOURCE_MyBucket", `{"name":"from-env-var"}`)
	os.Setenv("SST_RESOURCES_JSON", `{"MyBucket":{"name":"from-json"}}`)
	defer os.Unsetenv("SST_RESOURCE_MyBucket")
	defer os.Unsetenv("SST_RESOURCES_JSON")

	loadFromEnv()

	val, err := Get("MyBucket", "name")
	if err != nil {
		t.Fatalf("expected MyBucket.name to exist: %v", err)
	}
	if val != "from-json" {
		t.Fatalf("expected MyBucket.name = from-json, got %v", val)
	}
}

func TestKeys_InvalidSSTResourcesJSONIgnored(t *testing.T) {
	resetResources()
	os.Setenv("SST_RESOURCES_JSON", `not-json`)
	defer os.Unsetenv("SST_RESOURCES_JSON")

	loadFromEnv()

	_, err := Get("MyBucket")
	if err == nil {
		t.Fatal("expected MyBucket to not exist")
	}
}

func TestGet_AllowsEmptyPath(t *testing.T) {
	resetResources()
	resources["TopLevel"] = "value"

	val, err := Get("TopLevel")
	if err != nil {
		t.Fatalf("expected TopLevel to exist: %v", err)
	}
	if val != "value" {
		t.Fatalf("expected TopLevel = value, got %v", val)
	}
}

func TestGet_ReturnsNotFound(t *testing.T) {
	resetResources()

	_, err := Get("Missing")
	if err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestKeys_EmptySSTResourcesJSONLeavesResources(t *testing.T) {
	resetResources()
	resources["Existing"] = "kept"
	os.Setenv("SST_RESOURCES_JSON", `{}`)
	defer os.Unsetenv("SST_RESOURCES_JSON")

	loadFromEnv()

	if len(resources) != 1 || resources["Existing"] != "kept" {
		t.Fatalf("expected resources unchanged, got %v", resources)
	}
}

// resources is nil when the decrypted file is the JSON null. An empty
// SST_RESOURCES_JSON then leaves it alone; a non-empty one panics, as it did
// before maps.Copy.
func TestKeys_SSTResourcesJSONIntoNilResources(t *testing.T) {
	defer resetResources()
	defer os.Unsetenv("SST_RESOURCES_JSON")

	resources = nil
	os.Setenv("SST_RESOURCES_JSON", `{}`)
	loadFromEnv()
	if resources != nil {
		t.Fatalf("expected resources to stay nil, got %v", resources)
	}

	resources = nil
	os.Setenv("SST_RESOURCES_JSON", `{"MyBucket":{"name":"my-bucket"}}`)
	defer func() {
		if recover() == nil {
			t.Fatal("expected a panic on a nil resources map")
		}
	}()
	loadFromEnv()
}
