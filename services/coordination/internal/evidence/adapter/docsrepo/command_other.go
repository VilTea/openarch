//go:build !windows

package docsrepo

import (
	"context"
	"os/exec"
)

func gitCommand(ctx context.Context, root string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, "git", append([]string{"-C", root}, args...)...)
}
