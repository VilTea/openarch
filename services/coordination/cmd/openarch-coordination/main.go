package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	scopedocsrepo "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/docsrepo"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/events"
	collaborationhttp "github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/httpapi"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/memory"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/signing"
	collaborationapplication "github.com/openarch/openarch/services/coordination/internal/collaboration/application"
	collaborationport "github.com/openarch/openarch/services/coordination/internal/collaboration/port"
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
	listen           string
	docsRepo         string
	gitRemote        string
	gitBranch        string
	gitAuthorName    string
	gitAuthorEmail   string
	taskSigningKey   string
	taskSigningKeyID string
	projectionPath   string
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
		listen:           *listen,
		docsRepo:         *docsRepo,
		gitRemote:        *gitRemote,
		gitBranch:        *gitBranch,
		gitAuthorName:    *gitAuthorName,
		gitAuthorEmail:   *gitAuthorEmail,
		taskSigningKey:   *taskSigningKey,
		taskSigningKeyID: *taskSigningKeyID,
		projectionPath:   *projectionPath,
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
	publisher := events.NewPublisher()
	if err := registerTaskRoutes(mux, cfg, authority, scopeStore, publisher); err != nil {
		return err
	}
	if err := registerDebtRoutes(mux, authority); err != nil {
		return err
	}
	registerLiveRoutes(mux, publisher)
	collaborationhttp.RegisterEventRoutes(mux, publisher)
	return serve(mux, cfg.listen)
}

// registerLiveRoutes wires the ephemeral live authorities (semantic leases and
// repository-bound sessions). Both are live runtime state, never Git-backed; a
// restart bumps the coordinator epoch and invalidates every outstanding
// credential.
func registerLiveRoutes(mux *http.ServeMux, publisher *events.Publisher) {
	epoch := uint64(time.Now().Unix())
	leaseStore, err := memory.New(epoch, time.Second, 10*time.Minute, time.Now)
	if err != nil {
		log.Fatalf("init lease store: %v", err)
	}
	collaborationhttp.RegisterLeaseRoutes(mux, leaseStore, publisher)

	sessionStore, err := memory.NewSessionStore(epoch, time.Second, 30*time.Minute, time.Now)
	if err != nil {
		log.Fatalf("init session store: %v", err)
	}
	collaborationhttp.RegisterSessionRoutes(mux, sessionStore, publisher)
}

// serve runs the coordination service with bounded HTTP timeouts and graceful
// shutdown. Slowloris-style requests are bounded at the transport layer; the
// application handlers keep their own request limits via MaxBytesReader.
func serve(mux *http.ServeMux, listen string) error {
	server := &http.Server{
		Addr:              listen,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      90 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errCh := make(chan error, 1)
	go func() {
		log.Printf("OpenArch coordination service listening on %s", listen)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Printf("coordination service shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
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

func registerDebtRoutes(mux *http.ServeMux, authority *docsrepo.Authority) error {
	debtStore, err := scopedocsrepo.NewDebtStore(authority.Repository())
	if err != nil {
		return err
	}
	debtService, err := collaborationapplication.NewDebtService(debtStore)
	if err != nil {
		return err
	}
	collaborationhttp.RegisterDebtRoutes(mux, debtService)
	log.Printf("Debt document listing enabled (Agent-owned Git documents)")
	return nil
}

func registerTaskRoutes(mux *http.ServeMux, cfg config, authority *docsrepo.Authority, scopeStore collaborationport.ScopeStore, publisher *events.Publisher) error {
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
	collaborationhttp.RegisterTaskRoutes(mux, taskService, publisher)
	return nil
}
