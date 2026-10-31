package floci

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/aws/aws-sdk-go-v2/service/ssm/types"
	"github.com/google/uuid"
	"github.com/sst/sst/v3/pkg/global"
)

const identityParameter = "/sst/floci/instance"

var configDir = global.ConfigDir

type stageMarker struct{ Instance, App, Stage string }

func endpointKey(endpoint string) string {
	sum := sha256.Sum256([]byte(endpoint))
	return hex.EncodeToString(sum[:])
}
func markerPath(cfg *Config, app, stage string) string {
	return filepath.Join(configDir(), "floci-stages", endpointKey(cfg.Endpoint), endpointKey(app+"\x00"+stage)+".json")
}
func identityClient(cfg *Config) (*ssm.Client, error) {
	if err := ValidateEndpoint(cfg.Endpoint); err != nil {
		return nil, err
	}
	return ssm.NewFromConfig(aws.Config{Region: cfg.Region, Credentials: credentials.NewStaticCredentialsProvider("test", "test", ""), BaseEndpoint: aws.String(cfg.Endpoint), HTTPClient: LocalHTTPClient()}), nil
}
func instance(ctx context.Context, cfg *Config) (string, error) {
	client, err := identityClient(cfg)
	if err != nil {
		return "", err
	}
	out, err := client.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(identityParameter)})
	var missing *types.ParameterNotFound
	if errors.As(err, &missing) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if out.Parameter == nil {
		return "", fmt.Errorf("Floci returned an empty instance parameter")
	}
	id := aws.ToString(out.Parameter.Value)
	if _, err := uuid.Parse(id); err != nil {
		return "", fmt.Errorf("Floci has an invalid instance identity: %w", err)
	}
	return id, nil
}
func setIdentity(cfg *Config, id string) {
	cfg.Instance = id
	if id != "" {
		cfg.StateRoot = filepath.Join(configDir(), "floci", id)
	} else {
		cfg.StateRoot = ""
	}
}

// ReadIdentity detects resets without writing to Floci. Call before compatibility preview.
func ReadIdentity(ctx context.Context, cfg *Config, app, stage string) error {
	id, err := instance(ctx, cfg)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(markerPath(cfg, app, stage))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil {
		var marker stageMarker
		if err := json.Unmarshal(data, &marker); err != nil {
			return fmt.Errorf("invalid Floci stage marker: %w", err)
		}
		if marker.Instance != id {
			return fmt.Errorf("Floci was reset or replaced; run sst floci reset --stage %s before continuing", stage)
		}
	}
	if id == "" {
		if cfg.identityPending {
			id = cfg.Instance
		} else {
			id = uuid.NewString()
		}
		cfg.identityPending = true
	} else {
		cfg.identityPending = false
	}
	setIdentity(cfg, id)
	return nil
}

// EnsureIdentity is deliberately separate from readiness: call only after preflight passes.
func EnsureIdentity(ctx context.Context, cfg *Config, app, stage string) error {
	expected := cfg.Instance
	current := *cfg
	if err := ReadIdentity(ctx, &current, app, stage); err != nil {
		return err
	}
	if expected != "" && current.Instance != expected {
		return fmt.Errorf("Floci identity changed during preflight; restart sst dev before continuing")
	}
	*cfg = current
	if cfg.identityPending {
		client, err := identityClient(cfg)
		if err != nil {
			return err
		}
		_, err = client.PutParameter(ctx, &ssm.PutParameterInput{Name: aws.String(identityParameter), Value: aws.String(cfg.Instance), Type: types.ParameterTypeString, Overwrite: aws.Bool(false)})
		var exists *types.ParameterAlreadyExists
		if errors.As(err, &exists) {
			current, readErr := instance(ctx, cfg)
			if readErr != nil {
				return readErr
			}
			if current != cfg.Instance {
				return fmt.Errorf("another process initialized Floci during preflight; restart sst dev before continuing")
			}
			err = nil
		}
		if err != nil {
			return err
		}
		cfg.identityPending = false
	}
	path := markerPath(cfg, app, stage)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(stageMarker{Instance: cfg.Instance, App: app, Stage: stage})
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

// Reset deletes only the managed instance. A stage limits local state cleanup, not
// the emulator wipe: all other stages detect the missing identity on next use.
func Reset(ctx context.Context, stage string) error { return reset(ctx, stage, docker) }

func reset(ctx context.Context, stage string, run dockerRunner) error {
	if stage != "" && !validSegment(stage) {
		return fmt.Errorf("invalid Floci stage: %q", stage)
	}
	cfg, err := endpointConfig()
	if err != nil {
		return err
	}
	if os.Getenv("SST_FLOCI_ENDPOINT") != "" {
		if stage == "" {
			return fmt.Errorf("custom endpoints require reset --stage <stage> for local state recovery; manage their emulator data separately")
		}
		return clearMarkers(cfg, stage)
	}
	info, err := inspect(ctx, run)
	if err != nil {
		return err
	}
	out, err := run(ctx, "volume", "ls", "--filter", "name=^"+volumeName+"$", "--format", "{{.Name}}")
	if err != nil {
		return err
	}
	if len(out) > 0 {
		if err := checkVolume(ctx, run); err != nil {
			return err
		}
	}
	registry, err := managedRegistry(ctx, run)
	if err != nil {
		return err
	}
	registryVolume, err := managedRegistryVolume(ctx, run)
	if err != nil {
		return err
	}
	if info != nil {
		if _, err = run(ctx, "rm", "-f", containerName); err != nil {
			return err
		}
	}
	if registry {
		if _, err = run(ctx, "rm", "-f", registryName); err != nil {
			return err
		}
	}
	if registryVolume {
		if _, err = run(ctx, "volume", "rm", registryVolumeName); err != nil {
			return err
		}
	}
	if len(out) > 0 {
		if _, err = run(ctx, "volume", "rm", volumeName); err != nil {
			return err
		}
	}
	return clearMarkers(cfg, stage)
}
func clearMarkers(cfg *Config, stage string) error {
	dir := filepath.Join(configDir(), "floci-stages", endpointKey(cfg.Endpoint))
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var marker stageMarker
		if err := json.Unmarshal(data, &marker); err != nil {
			return err
		}
		if stage != "" && marker.Stage != stage {
			continue
		}
		if _, err := uuid.Parse(marker.Instance); err != nil {
			return fmt.Errorf("invalid instance identity in %s", path)
		}
		if !validSegment(marker.App) || !validSegment(marker.Stage) {
			return fmt.Errorf("invalid stage marker in %s", path)
		}
		root := filepath.Join(configDir(), "floci", marker.Instance)
		if stage == "" {
			err = os.RemoveAll(root)
		} else {
			for _, key := range []string{"app", "secret", "passphrase", "lock", "update", "summary", "eventlog", "snapshot"} {
				for _, suffix := range []string{"", ".json"} {
					if err = os.RemoveAll(filepath.Join(root, "state", key, marker.App, marker.Stage+suffix)); err != nil {
						return err
					}
				}
			}
		}
		if err != nil {
			return err
		}
		if err = os.Remove(path); err != nil {
			return err
		}
	}
	return nil
}

func validSegment(value string) bool {
	return value != "" && value != "." && value != ".." && filepath.Base(value) == value
}
