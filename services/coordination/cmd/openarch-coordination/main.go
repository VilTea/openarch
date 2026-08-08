package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	collaborationport "github.com/openarch/openarch/services/coordination/internal/collaboration/port"
	scopedocsrepo "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/docsrepo"
	collaborationhttp "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/httpapi"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/memory"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/signing"
	collaborationapplication "github.com/openarch/openarch/services/coordination/internal/collaboration/application"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/httpapi"
	"github.com/openarch/openarch/services/coordination/internal/evidence/adapter/ndjson"
	"github.com/openarch/openarch/services/coordination/internal/evidence/application"
)

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

type config struct {
	listen         string
	docsRepo       string
	gitRemote      string
	gitBranch      string
	gitAuthorName  string
	gitAuthorEmail string
	taskSigningKey string
	taskSigningKeyID string
	projectionPath string
}

func main() {
	listen := flag.String("listen", "127.0.0.1:8787", "loopback address for the coordination service")
	docsRepo := flag.String("docs-repo", "", "path to the git collaboration docs repository worktree")
	gitRemote := flag.String("git-remote", "", "remote name for shared docs-repo authority; empty = local mode (agents share one local worktree via junction/symlink, commits are visible directly)")
	gitBranch := flag.String("git-branch", "", "shared authority branch; defaults to the checked-out branch")
	gitAuthorName := flag.String("git-author-name", "OpenArch Coordination", "Git author name for service-owned docs-repo commits")
	gitAuthorEmail := flag.String("git-author-email", "coordination@openarch.local", "Git author email for service-owned docs-repo commits")
	taskSigningKey := flag.String("task-signing-key", "", "base64 Ed25519 seed/private-key file required to enable Task verification")
	taskSigningKeyID := flag.String("task-signing-key-id", "coordination-task-v1", "stable identifier for the Task event signing key")
	projectionPath := flag.String("projection", "", "local rebuildable projection cache path; empty = system temp dir (disposable, rebuildable from Git)")
	flag.Parse()
	cfg := config{
		listen:          *listen,
		docsRepo:        *docsRepo,
		gitRemote:       *gitRemote,
		gitBranch:       *gitBranch,
		gitAuthorName:   *gitAuthorName,
		gitAuthorEmail:  *gitAuthorEmail,
		taskSigningKey:  *taskSigningKey,
		taskSigningKeyID: *taskSigningKeyID,
		projectionPath:  *projectionPath,
	}
	if err := run(cfg); err != nil {
		log.Fatal(err)
	}
}

func run(cfg config) error {
	authority, scopeStore, err := openAuthority(cfg)
	if err != nil {
		return err
	}
	defer authority.Close()
	projection, err := openProjection(cfg)
	if err != nil {
		return err
	}
	defer projection.Close()
	service := application.NewService(authority, projection, scopeStore)
	descriptor, err := authority.Descriptor(context.Background())
	if err != nil {
		return err
	}
	log.Printf("OpenArch coordination docs-repo remote=%s branch=%s head=%s", descriptor.RemoteURL, descriptor.Branch, descriptor.HeadSHA)
	log.Printf("OpenArch coordination evidence service listening on %s", cfg.listen)
	mux := http.NewServeMux()
	httpapi.Register(mux, service)
	if err := registerTaskRoutes(mux, cfg, authority, scopeStore); err != nil {
		return err
	}
	registerLeaseRoutes(mux)
	return http.ListenAndServe(cfg.listen, mux)
}

// registerLeaseRoutes wires the ephemeral semantic-lease store. Leases are live
// runtime state (never Git-backed); a restart bumps the coordinator epoch and
// invalidates every outstanding credential.
func registerLeaseRoutes(mux *http.ServeMux) {
	leaseStore, err := memory.New(
		uint64(time.Now().Unix()), // coordinator epoch: restart invalidates leases
		time.Second,               // min TTL
		10*time.Minute,            // max TTL
		time.Now,
	)
	if err != nil {
		log.Fatalf("init lease store: %v", err)
	}
	collaborationhttp.RegisterLeaseRoutes(mux, leaseStore)
}

func openAuthority(cfg config) (*docsrepo.Authority, collaborationport.ScopeStore, error) {
	if cfg.docsRepo == "" {
		return nil, nil, fmt.Errorf("--docs-repo is required")
	}
	authority, err := docsrepo.Open(
		cfg.docsRepo,
		docsrepo.WithRemote(cfg.gitRemote),
		docsrepo.WithBranch(cfg.gitBranch),
		docsrepo.WithCommitIdentity(cfg.gitAuthorName, cfg.gitAuthorEmail),
	)
	if err != nil {
		return nil, nil, err
	}
	scopeStore, err := scopedocsrepo.New(authority.Repository())
	if err != nil {
		authority.Close()
		return nil, nil, err
	}
	return authority, scopeStore, nil
}

func openProjection(cfg config) (*ndjson.Store, error) {
	resolved := cfg.projectionPath
	if resolved == "" {
		// The projection is a disposable cache derived from the Git authority.
		// Default to the system temp dir so it never pollutes a project worktree
		// or the shared docs-repo. A stable name keeps restarts on the same host
		// from duplicating it until a refresh rebuilds it from Git.
		resolved = filepath.Join(os.TempDir(), "openarch-coordination-"+sha256Hex(cfg.docsRepo)[:12]+".ndjson")
	}
	return ndjson.Open(resolved)
}

func registerTaskRoutes(mux *http.ServeMux, cfg config, authority *docsrepo.Authority, scopeStore collaborationport.ScopeStore) error {
	if cfg.taskSigningKey == "" {
		log.Printf("Task verification endpoints disabled: --task-signing-key is required")
		return nil
	}
	authenticator, err := signing.LoadEd25519TaskEventAuthenticator(cfg.taskSigningKeyID, cfg.taskSigningKey)
	if err != nil {
		return err
	}
	taskStore, err := scopedocsrepo.NewTaskStore(authority.Repository(), authority, authenticator)
	if err != nil {
		return err
	}
	taskService, err := collaborationapplication.NewTaskService(authority, scopeStore, taskStore, authenticator, time.Now)
	if err != nil {
		return err
	}
	collaborationhttp.RegisterTaskRoutes(mux, taskService)
	return nil
}
