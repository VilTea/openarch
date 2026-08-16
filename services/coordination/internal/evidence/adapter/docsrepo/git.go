package docsrepo

import (
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
)

type gitClient struct {
	root       string
	remote     string
	branch     string
	authorName string
	authorMail string
	local      bool
}

func newGitClient(ctx context.Context, root string, config authorityConfig) (gitClient, error) {
	client := gitClient{
		root:       root,
		remote:     config.remote,
		branch:     config.branch,
		authorName: config.authorName,
		authorMail: config.authorMail,
	}
	if err := client.applyRemoteConfig(config.remote); err != nil {
		return gitClient{}, err
	}
	if output, err := client.run(ctx, "rev-parse", "--is-inside-work-tree"); err != nil || strings.TrimSpace(output) != "true" {
		return gitClient{}, fmt.Errorf("docs-repo must be a Git worktree: %w", err)
	}
	if err := client.resolveCheckedOutBranch(ctx); err != nil {
		return gitClient{}, err
	}
	if err := validateBranch(client.branch); err != nil {
		return gitClient{}, err
	}
	if !client.local {
		if _, err := client.run(ctx, "remote", "get-url", client.remote); err != nil {
			return gitClient{}, fmt.Errorf("docs-repo remote %q is required: %w", client.remote, err)
		}
	}
	return client, nil
}

// applyRemoteConfig decides between local mode (empty remote: the shared
// worktree itself is the authority) and remote mode with a named remote.
func (client *gitClient) applyRemoteConfig(remote string) error {
	// Local mode: no remote authority. Multiple agents share one local docs-repo
	// worktree (via junction/symlink); commits are visible directly, so remote
	// fetch/push/head checks are skipped and the local HEAD is the authority.
	if strings.TrimSpace(remote) == "" {
		client.local = true
		return nil
	}
	if strings.HasPrefix(remote, "-") || strings.ContainsAny(remote, "\x00\r\n") {
		return fmt.Errorf("docs-repo remote name is invalid")
	}
	client.remote = remote
	return nil
}

// resolveCheckedOutBranch pins client.branch to the checked-out branch when not
// configured, and rejects a configured branch that is not checked out.
func (client *gitClient) resolveCheckedOutBranch(ctx context.Context) error {
	checkedOutBranch, err := client.run(ctx, "branch", "--show-current")
	if err != nil {
		return err
	}
	checkedOutBranch = strings.TrimSpace(checkedOutBranch)
	if checkedOutBranch == "" {
		return fmt.Errorf("docs-repo must have a checked-out branch")
	}
	if client.branch == "" {
		client.branch = checkedOutBranch
	} else if client.branch != checkedOutBranch {
		return fmt.Errorf("configured authority branch %q is not the checked-out branch %q", client.branch, checkedOutBranch)
	}
	return nil
}

func validateBranch(branch string) error {
	if branch == "" || strings.HasPrefix(branch, "-") || strings.ContainsAny(branch, "\x00\r\n ~^:?*[\\") || strings.Contains(branch, "..") || strings.HasSuffix(branch, ".") || strings.HasSuffix(branch, "/") || strings.HasPrefix(branch, "/") || strings.Contains(branch, "//") {
		return fmt.Errorf("docs-repo branch %q is invalid", branch)
	}
	return nil
}

func (g gitClient) ensureSynchronized(ctx context.Context) error {
	if g.local {
		// Local mode shares the worktree directly; there is no remote to synchronize with.
		return nil
	}
	head, err := g.run(ctx, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	remoteHead, err := g.run(ctx, "ls-remote", "--heads", g.remote, "refs/heads/"+g.branch)
	if err != nil {
		return err
	}
	fields := strings.Fields(remoteHead)
	if len(fields) == 0 {
		return fmt.Errorf("remote %q has no branch %q; bootstrap and push the docs-repo before starting the service", g.remote, g.branch)
	}
	if strings.TrimSpace(head) != fields[0] {
		return fmt.Errorf("docs-repo HEAD is not synchronized with %s/%s", g.remote, g.branch)
	}
	return nil
}

func (g gitClient) descriptor(ctx context.Context) (RemoteDescriptor, error) {
	if g.local {
		head, err := g.run(ctx, "rev-parse", "HEAD")
		if err != nil {
			return RemoteDescriptor{}, err
		}
		absolute, err := filepath.Abs(g.root)
		if err != nil {
			return RemoteDescriptor{}, err
		}
		return RemoteDescriptor{
			RemoteURL: filepath.ToSlash(absolute),
			Branch:    g.branch,
			HeadSHA:   strings.TrimSpace(head),
		}, nil
	}
	remoteURL, err := g.run(ctx, "remote", "get-url", g.remote)
	if err != nil {
		return RemoteDescriptor{}, fmt.Errorf("read docs-repo remote: %w", err)
	}
	head, err := g.remoteHead(ctx)
	if err != nil {
		return RemoteDescriptor{}, err
	}
	return RemoteDescriptor{
		RemoteURL: redactRemoteURL(strings.TrimSpace(remoteURL)),
		Branch:    g.branch,
		HeadSHA:   strings.TrimSpace(head),
	}, nil
}

func (g gitClient) refreshFromRemote(ctx context.Context, expectedBranch string, expectedHead string) (RemoteDescriptor, error) {
	return g.refreshFromRemoteWithServiceDescendants(ctx, expectedBranch, expectedHead, false)
}

func (g gitClient) refreshFromRemoteWithServiceDescendants(ctx context.Context, expectedBranch string, expectedHead string, allowServiceDescendants bool) (RemoteDescriptor, error) {
	if strings.TrimSpace(expectedBranch) != "" && strings.TrimSpace(expectedBranch) != g.branch {
		return RemoteDescriptor{}, fmt.Errorf("refresh branch %q does not match configured docs-repo branch %q", expectedBranch, g.branch)
	}
	dirty, err := g.hasPathChanges(ctx, ".")
	if err != nil {
		return RemoteDescriptor{}, err
	}
	if dirty {
		return RemoteDescriptor{}, fmt.Errorf("docs-repo service worktree has uncommitted changes; refusing refresh")
	}
	if !g.local {
		if _, err := g.run(ctx, "fetch", "--prune", g.remote, g.branch); err != nil {
			return RemoteDescriptor{}, fmt.Errorf("fetch docs-repo remote: %w", err)
		}
	}
	remoteHead, err := g.remoteHead(ctx)
	if err != nil {
		return RemoteDescriptor{}, err
	}
	if g.local {
		return g.refreshLocal(ctx, expectedHead)
	}
	if expected := strings.TrimSpace(expectedHead); expected != "" && expected != remoteHead {
		if err := g.validateRefreshHead(ctx, expected, remoteHead, allowServiceDescendants); err != nil {
			return RemoteDescriptor{}, err
		}
	}
	if err := g.advanceWorktree(ctx, remoteHead); err != nil {
		return RemoteDescriptor{}, err
	}
	return g.descriptor(ctx)
}

// validateRefreshHead accepts an advertised head that is an ancestor of remote
// truth. A shared docs-repo can carry several projects on one branch: a
// project may advertise its own pushed head while another project has advanced
// the remote in the meantime. For a read-side refresh that is safe because the
// worktree only fast-forwards and the returned descriptor reports the actual
// head. Strict callers that must bind to the advertised commit additionally
// require every descendant change to be service-owned.
func (g gitClient) validateRefreshHead(ctx context.Context, expectedHead string, remoteHead string, allowServiceDescendants bool) error {
	if !g.isAncestor(ctx, expectedHead, remoteHead) {
		return fmt.Errorf("refresh head %q is not an ancestor of remote head %q", expectedHead, remoteHead)
	}
	if !allowServiceDescendants {
		return nil
	}
	changed, err := g.run(ctx, "diff", "--name-only", expectedHead, remoteHead)
	if err != nil {
		return err
	}
	for _, path := range strings.Fields(changed) {
		if !isServiceOwnedPath(path) {
			return fmt.Errorf("refresh head %q has non-service-owned descendant change %q", expectedHead, path)
		}
	}
	return nil
}

// refreshLocal validates the advertised head against the shared local worktree
// and returns the local descriptor. Local mode needs no fetch/reset because the
// worktree is the shared directory every agent commits into.
func (g gitClient) refreshLocal(ctx context.Context, expectedHead string) (RemoteDescriptor, error) {
	remoteHead, err := g.remoteHead(ctx)
	if err != nil {
		return RemoteDescriptor{}, err
	}
	if expected := strings.TrimSpace(expectedHead); expected != "" && expected != remoteHead && !g.isAncestor(ctx, expected, remoteHead) {
		return RemoteDescriptor{}, fmt.Errorf("refresh head %q is not an ancestor of local HEAD %q", expectedHead, remoteHead)
	}
	return g.descriptor(ctx)
}

// advanceWorktree fast-forwards the service worktree to remoteHead when it is
// behind; it refuses to reset when the local head has diverged.
func (g gitClient) advanceWorktree(ctx context.Context, remoteHead string) error {
	head, err := g.run(ctx, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	head = strings.TrimSpace(head)
	if head == remoteHead {
		return nil
	}
	if !g.isAncestor(ctx, head, remoteHead) {
		return fmt.Errorf("docs-repo local head diverged from remote branch %s/%s", g.remote, g.branch)
	}
	if _, err := g.run(ctx, "reset", "--hard", remoteHead); err != nil {
		return fmt.Errorf("advance docs-repo worktree: %w", err)
	}
	return nil
}

func (g gitClient) isAncestor(ctx context.Context, ancestor string, descendant string) bool {
	return exec.CommandContext(ctx, "git", "-C", g.root, "merge-base", "--is-ancestor", ancestor, descendant).Run() == nil
}

func (g gitClient) remoteHead(ctx context.Context) (string, error) {
	if g.local {
		output, err := g.run(ctx, "rev-parse", "HEAD")
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(output), nil
	}
	output, err := g.run(ctx, "ls-remote", "--heads", g.remote, "refs/heads/"+g.branch)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(output)
	if len(fields) == 0 {
		return "", fmt.Errorf("remote %q has no branch %q", g.remote, g.branch)
	}
	return strings.TrimSpace(fields[0]), nil
}

func redactRemoteURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err == nil && parsed.Scheme != "" {
		parsed.User = nil
		return parsed.String()
	}
	// SCP-like Git URLs use a non-secret `git@host:` user in common setups.
	// Drop any other user component so a token cannot leak through the API.
	if at := strings.Index(raw, "@"); at > 0 {
		user := raw[:at]
		if user != "git" {
			return raw[at+1:]
		}
	}
	return raw
}

func (g gitClient) hasDiff(ctx context.Context, args ...string) (bool, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", g.root, "diff", "--quiet"}, args...)...)
	err := command.Run()
	if err == nil {
		return false, nil
	}
	if exitError, ok := err.(*exec.ExitError); ok && exitError.ExitCode() == 1 {
		return true, nil
	}
	return false, fmt.Errorf("git diff: %w", err)
}

func (g gitClient) hasPathAtHead(ctx context.Context, path string) (bool, error) {
	output, err := g.run(ctx, "ls-tree", "-r", "--name-only", "HEAD", "--", path)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(output) != "", nil
}

func (g gitClient) hasPathChanges(ctx context.Context, path string) (bool, error) {
	args := []string{"status", "--porcelain"}
	if path != "." {
		args = append(args, "--", path)
	}
	output, err := g.run(ctx, args...)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(output) != "", nil
}

func (g gitClient) run(ctx context.Context, args ...string) (string, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", g.root}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}
