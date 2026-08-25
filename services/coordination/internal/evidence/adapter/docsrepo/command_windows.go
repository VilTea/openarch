//go:build windows

package docsrepo

import (
	"context"
	"os/exec"
	"syscall"
)

// gitCommand builds a git command rooted at root. On Windows the child is
// created with CREATE_NO_WINDOW so a service launched without a console does
// not flash a new terminal window for every git subprocess.
func gitCommand(ctx context.Context, root string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", root}, args...)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
	return cmd
}
