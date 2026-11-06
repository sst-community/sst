package floci

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// CheckNode checks the executable actually selected by PATH, including backports.
func CheckNode(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "node", "--use-env-proxy", "--version").CombinedOutput()
	if err != nil {
		return fmt.Errorf("Floci requires Node.js with --use-env-proxy support. Install Node.js 24.5 or later and check which node is on PATH. Node check failed: %w\n%s", err, strings.TrimSpace(string(output)))
	}
	return nil
}
