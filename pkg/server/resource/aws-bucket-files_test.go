package resource

import (
	"errors"
	"fmt"
	"testing"

	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
)

// smithyAPIError is a minimal smithy.APIError implementation used to simulate
// errors that carry a NoSuchBucket code without the modeled *s3types.NoSuchBucket.
type smithyAPIError struct {
	code    string
	message string
}

func (e *smithyAPIError) Error() string                 { return fmt.Sprintf("%s: %s", e.code, e.message) }
func (e *smithyAPIError) ErrorCode() string             { return e.code }
func (e *smithyAPIError) ErrorMessage() string          { return e.message }
func (e *smithyAPIError) ErrorFault() smithy.ErrorFault { return smithy.FaultClient }

func TestIsBucketAbsent(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "typed NoSuchBucket is absent",
			err:  &s3types.NoSuchBucket{},
			want: true,
		},
		{
			name: "wrapped typed NoSuchBucket is absent",
			err:  fmt.Errorf("delete failed: %w", &s3types.NoSuchBucket{}),
			want: true,
		},
		{
			name: "smithy APIError with NoSuchBucket code is absent",
			err:  &smithyAPIError{code: "NoSuchBucket", message: "The specified bucket does not exist"},
			want: true,
		},
		{
			name: "AccessDenied is not absent",
			err:  &smithyAPIError{code: "AccessDenied", message: "Access Denied"},
			want: false,
		},
		{
			name: "generic error is not absent",
			err:  errors.New("connection reset"),
			want: false,
		},
		{
			name: "nil error is not absent",
			err:  nil,
			want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isBucketAbsent(tc.err); got != tc.want {
				t.Fatalf("isBucketAbsent(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestDeleteSwallowsOnlyMissingBucket documents the intended delete-path
// contract that isBucketAbsent gates: a missing bucket is success on delete,
// while AccessDenied (and any other error) must still propagate.
func TestDeleteSwallowsOnlyMissingBucket(t *testing.T) {
	// Simulates the branch in Delete: `if isBucketAbsent(err) { return nil }`.
	deleteResult := func(purgeErr error) error {
		if purgeErr != nil {
			if isBucketAbsent(purgeErr) {
				return nil
			}
			return purgeErr
		}
		return nil
	}

	if err := deleteResult(&s3types.NoSuchBucket{}); err != nil {
		t.Fatalf("missing bucket on delete should succeed, got %v", err)
	}
	accessDenied := &smithyAPIError{code: "AccessDenied", message: "Access Denied"}
	if err := deleteResult(accessDenied); err == nil {
		t.Fatal("AccessDenied on delete must remain an error")
	}
	if err := deleteResult(nil); err != nil {
		t.Fatalf("successful purge should return nil, got %v", err)
	}
}
