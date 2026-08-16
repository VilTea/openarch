package docsrepo

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

// Repository is the shared durable Git worktree read boundary. Bounded
// contexts own their document schemas; this type can fetch and read the
// service worktree but cannot publish agent-owned documents.
type Repository struct {
	root string
	git  gitClient
	mu   *sync.Mutex
}

type RemoteDescriptor = domain.DurableRepositoryDescriptor

func OpenRepository(root string, options ...Option) (*Repository, error) {
	config := authorityConfig{remote: "origin"}
	for _, option := range options {
		option(&config)
	}
	git, err := newGitClient(context.Background(), root, config)
	if err != nil {
		return nil, err
	}
	if err := git.ensureSynchronized(context.Background()); err != nil {
		return nil, err
	}
	return &Repository{root: root, git: git, mu: &sync.Mutex{}}, nil
}

func (r *Repository) Root() string { return r.root }

// Descriptor exposes only the remote information an agent needs to build its
// local docs-repo. It intentionally does not expose the service worktree
// path, Git credentials, or a local projection location.
func (r *Repository) Descriptor(ctx context.Context) (RemoteDescriptor, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.git.descriptor(ctx)
}

// RefreshFromRemote advances the service's disposable worktree to an agent's
// already-pushed head. Only a fast-forward is accepted; a diverged or dirty
// service worktree is unavailable rather than silently repaired.
func (r *Repository) RefreshFromRemote(ctx context.Context, expectedBranch string, expectedHead string) (RemoteDescriptor, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	descriptor, err := r.git.refreshFromRemote(ctx, expectedBranch, expectedHead)
	if err != nil {
		return RemoteDescriptor{}, err
	}
	return descriptor, nil
}

func (r *Repository) ReadFileAtHead(ctx context.Context, path string) ([]byte, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := validateRelativePath(path); err != nil {
		return nil, false, err
	}
	if err := r.git.ensureSynchronized(ctx); err != nil {
		return nil, false, err
	}
	exists, err := r.git.hasPathAtHead(ctx, path)
	if err != nil || !exists {
		return nil, exists, err
	}
	payload, err := r.git.run(ctx, "show", "HEAD:"+filepath.ToSlash(path))
	if err != nil {
		return nil, false, err
	}
	return []byte(payload), true, nil
}

func (r *Repository) ListFilesAtHead(ctx context.Context, prefix string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := validateRelativePath(prefix); err != nil {
		return nil, err
	}
	if err := r.git.ensureSynchronized(ctx); err != nil {
		return nil, err
	}
	output, err := r.git.run(ctx, "ls-tree", "-r", "--name-only", "HEAD", "--", filepath.ToSlash(prefix))
	if err != nil {
		return nil, err
	}
	paths := make([]string, 0)
	for _, line := range strings.Split(output, "\n") {
		if value := strings.TrimSpace(line); value != "" {
			paths = append(paths, filepath.ToSlash(value))
		}
	}
	return paths, nil
}

// HeadFileSnapshot is one file read from a single synchronized HEAD. List-based
// projections use ReadListedFilesAtHead so they never mix files from different
// remote heads or pay one `ls-remote`/`ls-tree` per document.
type HeadFileSnapshot struct {
	Path    string
	Content []byte
}

// ReadListedFilesAtHead lists and reads every file under prefix from one HEAD
// snapshot with a single synchronization and one path listing. Callers must
// treat missing entries as impossible: files enumerated from HEAD are read
// from the same HEAD under the repository mutex.
func (r *Repository) ReadListedFilesAtHead(ctx context.Context, prefix string) ([]HeadFileSnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := validateRelativePath(prefix); err != nil {
		return nil, err
	}
	if err := r.git.ensureSynchronized(ctx); err != nil {
		return nil, err
	}
	output, err := r.git.run(ctx, "ls-tree", "-r", "--name-only", "HEAD", "--", filepath.ToSlash(prefix))
	if err != nil {
		return nil, err
	}
	snapshots := make([]HeadFileSnapshot, 0)
	for _, line := range strings.Split(output, "\n") {
		path := strings.TrimSpace(line)
		if path == "" {
			continue
		}
		path = filepath.ToSlash(path)
		payload, err := r.git.run(ctx, "show", "HEAD:"+path)
		if err != nil {
			return nil, err
		}
		snapshots = append(snapshots, HeadFileSnapshot{Path: path, Content: []byte(payload)})
	}
	return snapshots, nil
}

func validateRelativePath(path string) error {
	canonical := filepath.ToSlash(path)
	if canonical == "" || canonical != strings.TrimSpace(canonical) || strings.HasPrefix(canonical, "/") || strings.Contains(canonical, "\x00") {
		return errors.New("durable path must be a relative repository path")
	}
	for _, part := range strings.Split(canonical, "/") {
		if part == "" || part == "." || part == ".." {
			return errors.New("durable path contains an invalid segment")
		}
	}
	return nil
}
