package provider

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/aws/smithy-go"
	"github.com/sst/sst/v3/internal/util"

	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	ssmTypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

// AwsHome keeps state in the versioned bucket `sst-state-<id>` the bootstrap
// made in the app's region, at `<kind>/<app>/<stage>.json`, and each stage's
// passphrase in the SSM SecureString `/sst/passphrase/<app>/<stage>`.
type AwsHome struct {
	provider *AwsProvider
	compress bool
}

var _ VersionedHome = (*AwsHome)(nil)

func NewAwsHome(provider *AwsProvider, compress bool) *AwsHome {
	return &AwsHome{
		provider: provider,
		compress: compress,
	}
}

func (a *AwsHome) Bootstrap() error {
	_, err := a.provider.Bootstrap(a.provider.config.Region)
	return err
}

func (a *AwsHome) objectKey(key Key) string {
	return path.Join(key.Kind, key.App, fmt.Sprintf("%v.json", key.Stage))
}

func (a *AwsHome) folder(key Key) string {
	return path.Join(key.Kind, key.App, key.Stage) + "/"
}

func (a *AwsHome) pathForPassphrase(app string, stage string) string {
	return "/" + strings.Join([]string{"sst", "passphrase", app, stage}, "/")
}

func (a *AwsHome) bucket() (*s3.Client, string, error) {
	bootstrap, err := a.provider.Bootstrap(a.provider.config.Region)
	if err != nil {
		return nil, "", err
	}
	return s3.NewFromConfig(a.provider.config), bootstrap.State, nil
}

func isNoSuchBucket(err error) bool {
	var apiErr smithy.APIError
	return errors.As(err, &apiErr) && apiErr.ErrorCode() == "NoSuchBucket"
}

func (a *AwsHome) Get(ctx context.Context, key Key) ([]byte, error) {
	client, bucket, err := a.bucket()
	if err != nil {
		return nil, err
	}
	result, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(a.objectKey(key)),
	})
	if err != nil {
		if isNoSuchBucket(err) {
			return nil, ErrBucketMissing
		}
		var nsk *s3types.NoSuchKey
		if errors.As(err, &nsk) {
			return nil, nil
		}
		return nil, err
	}
	defer result.Body.Close()
	reader, err := gzipDecode(result.Body)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(reader)
}

func (a *AwsHome) Put(ctx context.Context, key Key, data []byte, opts PutOptions) error {
	client, bucket, err := a.bucket()
	if err != nil {
		return err
	}
	var body io.Reader = bytes.NewReader(data)
	var contentEncoding *string
	if a.compress {
		body, err = gzipEncode(body)
		if err != nil {
			return err
		}
		contentEncoding = aws.String("gzip")
	}
	input := &s3.PutObjectInput{
		Bucket:          aws.String(bucket),
		Key:             aws.String(a.objectKey(key)),
		Body:            body,
		ContentType:     aws.String("application/json"),
		ContentEncoding: contentEncoding,
	}
	if opts.IfAbsent {
		// S3 writes it only if no object is there, and refuses one of two
		// writes that race.
		input.IfNoneMatch = aws.String("*")
	}
	_, err = client.PutObject(ctx, input)
	if err != nil && opts.IfAbsent && isConditionFailed(err) {
		return ErrExists
	}
	if isNoSuchBucket(err) {
		return ErrBucketMissing
	}
	return err
}

// isConditionFailed is S3 refusing a conditional write: 412 when an object is
// there, 409 when another conditional write to the key was in flight.
func isConditionFailed(err error) bool {
	var apiErr smithy.APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	switch apiErr.ErrorCode() {
	case "PreconditionFailed", "ConditionalRequestConflict":
		return true
	}
	return false
}

// Remove leaves a delete marker on each key, as a delete in a versioned
// bucket does. Prune and purge remove the versions.
func (a *AwsHome) Remove(ctx context.Context, keys ...Key) error {
	if len(keys) == 0 {
		return nil
	}
	client, bucket, err := a.bucket()
	if err != nil {
		return err
	}
	if len(keys) == 1 {
		_, err = client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(bucket),
			Key:    aws.String(a.objectKey(keys[0])),
		})
		if isNoSuchBucket(err) {
			return ErrBucketMissing
		}
		return err
	}
	ids := make([]s3types.ObjectIdentifier, len(keys))
	for i, key := range keys {
		ids[i] = s3types.ObjectIdentifier{Key: aws.String(a.objectKey(key))}
	}
	return a.deleteObjects(ctx, client, bucket, ids)
}

func (a *AwsHome) List(ctx context.Context, prefix Key) ([]Key, error) {
	client, bucket, err := a.bucket()
	if err != nil {
		return nil, err
	}
	folder := a.folder(prefix)
	var keys []Key
	var continuationToken *string
	for {
		out, err := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(bucket),
			Prefix:            aws.String(folder),
			ContinuationToken: continuationToken,
		})
		if err != nil {
			if isNoSuchBucket(err) {
				return nil, ErrBucketMissing
			}
			return nil, err
		}
		for _, object := range out.Contents {
			name := strings.TrimPrefix(aws.ToString(object.Key), folder)
			if !strings.HasSuffix(name, ".json") {
				continue
			}
			keys = append(keys, Key{
				Kind:  prefix.Kind,
				App:   prefix.App,
				Stage: path.Join(prefix.Stage, strings.TrimSuffix(name, ".json")),
			})
		}
		if out.IsTruncated == nil || !*out.IsTruncated {
			break
		}
		continuationToken = out.NextContinuationToken
	}
	return keys, nil
}

func (a *AwsHome) RemoveVersions(ctx context.Context, key Key, folder bool) error {
	client, bucket, err := a.bucket()
	if err != nil {
		return err
	}
	prefix := a.objectKey(key)
	if folder {
		prefix = a.folder(key)
	}
	slog.Info("purging prefix", "bucket", bucket, "prefix", prefix)
	var ids []s3types.ObjectIdentifier
	err = listVersions(ctx, client, bucket, prefix, func(out *s3.ListObjectVersionsOutput) {
		for _, v := range out.Versions {
			if folder || aws.ToString(v.Key) == prefix {
				ids = append(ids, s3types.ObjectIdentifier{Key: v.Key, VersionId: v.VersionId})
			}
		}
		for _, dm := range out.DeleteMarkers {
			if folder || aws.ToString(dm.Key) == prefix {
				ids = append(ids, s3types.ObjectIdentifier{Key: dm.Key, VersionId: dm.VersionId})
			}
		}
	})
	if isNoSuchBucket(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return a.deleteObjects(ctx, client, bucket, ids)
}

func (a *AwsHome) PruneVersions(ctx context.Context, key Key) error {
	client, bucket, err := a.bucket()
	if err != nil {
		return err
	}
	objectKey := a.objectKey(key)
	var ids []s3types.ObjectIdentifier
	err = listVersions(ctx, client, bucket, objectKey, func(out *s3.ListObjectVersionsOutput) {
		ids = append(ids, noncurrentVersionIdentifiers(out, objectKey)...)
	})
	if err != nil {
		return err
	}
	return a.deleteObjects(ctx, client, bucket, ids)
}

// listVersions calls page with each page of the versions under prefix.
func listVersions(ctx context.Context, client *s3.Client, bucket, prefix string, page func(*s3.ListObjectVersionsOutput)) error {
	var keyMarker, versionMarker *string
	for {
		out, err := client.ListObjectVersions(ctx, &s3.ListObjectVersionsInput{
			Bucket:          aws.String(bucket),
			Prefix:          aws.String(prefix),
			KeyMarker:       keyMarker,
			VersionIdMarker: versionMarker,
		})
		if err != nil {
			return err
		}
		page(out)
		if out.IsTruncated == nil || !*out.IsTruncated {
			return nil
		}
		keyMarker = out.NextKeyMarker
		versionMarker = out.NextVersionIdMarker
	}
}

func noncurrentVersionIdentifiers(out *s3.ListObjectVersionsOutput, key string) []s3types.ObjectIdentifier {
	ids := make([]s3types.ObjectIdentifier, 0, len(out.Versions)+len(out.DeleteMarkers))
	for _, version := range out.Versions {
		if aws.ToString(version.Key) == key && !aws.ToBool(version.IsLatest) {
			ids = append(ids, s3types.ObjectIdentifier{Key: version.Key, VersionId: version.VersionId})
		}
	}
	for _, marker := range out.DeleteMarkers {
		if aws.ToString(marker.Key) == key && !aws.ToBool(marker.IsLatest) {
			ids = append(ids, s3types.ObjectIdentifier{Key: marker.Key, VersionId: marker.VersionId})
		}
	}
	return ids
}

// deleteObjects deletes in batches of 1,000, the most S3 takes at once.
func (a *AwsHome) deleteObjects(ctx context.Context, client *s3.Client, bucket string, ids []s3types.ObjectIdentifier) error {
	for i := 0; i < len(ids); i += 1000 {
		end := i + 1000
		if end > len(ids) {
			end = len(ids)
		}
		out, err := client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(bucket),
			Delete: &s3types.Delete{Objects: ids[i:end], Quiet: aws.Bool(true)},
		})
		if err != nil {
			return err
		}
		if len(out.Errors) > 0 {
			item := out.Errors[0]
			name := aws.ToString(item.Key)
			if item.VersionId != nil {
				name += " version " + aws.ToString(item.VersionId)
			}
			return fmt.Errorf("failed to delete state object %s: %s", name, aws.ToString(item.Message))
		}
	}
	return nil
}

func (a *AwsHome) Passphrase(ctx context.Context, app string, stage string) (string, error) {
	ssmClient := ssm.NewFromConfig(a.provider.config)
	result, err := ssmClient.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(a.pathForPassphrase(app, stage)),
		WithDecryption: aws.Bool(true),
	})
	if err != nil {
		pnf := &ssmTypes.ParameterNotFound{}
		if errors.As(err, &pnf) {
			return "", nil
		}
		return "", err
	}
	return *result.Parameter.Value, nil
}

func (a *AwsHome) CreatePassphrase(ctx context.Context, app, stage, passphrase string) error {
	ssmClient := ssm.NewFromConfig(a.provider.config)
	_, err := ssmClient.PutParameter(ctx, &ssm.PutParameterInput{
		Name:        aws.String(a.pathForPassphrase(app, stage)),
		Type:        ssmTypes.ParameterTypeSecureString,
		Value:       aws.String(passphrase),
		Description: aws.String("DO NOT DELETE STATE WILL BECOME UNRECOVERABLE"),
		Overwrite:   aws.Bool(false),
	})
	var exists *ssmTypes.ParameterAlreadyExists
	if errors.As(err, &exists) {
		return ErrExists
	}
	return err
}

func (a *AwsHome) RemovePassphrase(ctx context.Context, app, stage string) error {
	ssmClient := ssm.NewFromConfig(a.provider.config)
	_, err := ssmClient.DeleteParameter(ctx, &ssm.DeleteParameterInput{
		Name: aws.String(a.pathForPassphrase(app, stage)),
	})
	if err != nil {
		var pnf *ssmTypes.ParameterNotFound
		if errors.As(err, &pnf) {
			return nil
		}
		return err
	}
	return nil
}

func (a *AwsHome) Info() (util.KeyValuePairs[string], error) {
	caller := sts.NewFromConfig(a.provider.config)
	identity, err := caller.GetCallerIdentity(context.Background(), &sts.GetCallerIdentityInput{})
	if err != nil {
		return nil, err
	}
	lines := util.KeyValuePairs[string]{
		{Key: "Provider", Value: "AWS"},
		{Key: "Region", Value: a.provider.config.Region},
		{Key: "Account", Value: *identity.Account},
	}
	if len(a.provider.profile) != 0 {
		lines = append(lines, util.KeyValuePair[string]{
			Key: "Profile", Value: a.provider.profile,
		})
	}
	return lines, nil
}
