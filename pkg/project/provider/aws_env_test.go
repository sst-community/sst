package provider

import (
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAwsRoles(t *testing.T) {
	roles := awsRoles(map[string]interface{}{
		"assumeRoles": []interface{}{
			map[string]interface{}{"roleArn": "arn:aws:iam::123456789012:role/a"},
			map[string]interface{}{"roleArn": "arn:aws:iam::123456789012:role/b", "sessionName": "ci"},
		},
	})
	assert.Equal(t, []AwsRole{
		{RoleArn: "arn:aws:iam::123456789012:role/a"},
		{RoleArn: "arn:aws:iam::123456789012:role/b", SessionName: "ci"},
	}, roles)
	assert.Empty(t, awsRoles(map[string]interface{}{}))
}

// What the CLI gives what it starts says how its credentials were made, so
// SST's provider makes its own the same way (pkg/provider/aws.go)
func TestAwsEnv(t *testing.T) {
	a := NewAwsProvider()
	a.config = aws.Config{
		Region:      "eu-west-2",
		Credentials: credentials.NewStaticCredentialsProvider("access-key", "secret-key", "token"),
	}
	a.profile = "lab"
	a.roles = []AwsRole{{RoleArn: "arn:aws:iam::123456789012:role/deploy", SessionName: "ci"}}

	env, err := a.Env()
	require.NoError(t, err)
	assert.Equal(t, "eu-west-2", env["SST_AWS_REGION"])
	assert.Equal(t, "lab", env["AWS_PROFILE"])
	assert.JSONEq(t, `[{"roleArn":"arn:aws:iam::123456789012:role/deploy","sessionName":"ci"}]`, env[EnvAwsAssumeRoles])

	// No roles, no variable
	a.roles = nil
	env, err = a.Env()
	require.NoError(t, err)
	_, ok := env[EnvAwsAssumeRoles]
	assert.False(t, ok)
}
