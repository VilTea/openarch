package docsrepo

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	collaborationdomain "github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/evidence/domain"
)

const defaultEvidenceFile = "evidence/validation.ndjson"

type Authority struct {
	root string
	git  gitClient
	mu   *sync.Mutex
}

type authorityConfig struct {
	remote     string
	branch     string
	authorName string
	authorMail string
}

type Option func(*authorityConfig)

func WithRemote(remote string) Option {
	return func(config *authorityConfig) { config.remote = remote }
}

func WithBranch(branch string) Option {
	return func(config *authorityConfig) { config.branch = branch }
}

func WithCommitIdentity(name string, mail string) Option {
	return func(config *authorityConfig) {
		config.authorName = name
		config.authorMail = mail
	}
}

func Open(root string, options ...Option) (*Authority, error) {
	config := authorityConfig{
		remote:     "origin",
		authorName: "OpenArch Coordination",
		authorMail: "coordination@openarch.local",
	}
	for _, option := range options {
		option(&config)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	git, err := newGitClient(ctx, root, config)
	if err != nil {
		return nil, err
	}
	if err := git.ensureSynchronized(ctx); err != nil {
		return nil, err
	}
	return &Authority{root: root, git: git, mu: &sync.Mutex{}}, nil
}

func (a *Authority) Close() error { return nil }

func (a *Authority) Root() string { return a.root }

// Repository exposes the same synchronized read boundary to other bounded
// contexts (for example scope projection). The returned adapter has no
// document write operation; service-owned writes remain explicit methods on
// Authority.
func (a *Authority) Repository() *Repository {
	return &Repository{root: a.root, git: a.git, mu: a.mu}
}

// Descriptor returns the synchronized remote identity used by local agents.
func (a *Authority) Descriptor(ctx context.Context) (RemoteDescriptor, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.git.descriptor(ctx)
}

// RefreshFromRemote is a read-side coordination operation. It advances only
// the service's disposable worktree to an already-pushed remote head; it does
// not create a durable document commit.
func (a *Authority) RefreshFromRemote(ctx context.Context, expectedBranch string, expectedHead string) (RemoteDescriptor, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.git.refreshFromRemote(ctx, expectedBranch, expectedHead)
}

// RefreshFromRemoteContaining permits a retried service workflow to name the
// pre-service Git head only when later remote commits touch service-owned
// paths exclusively. Agent-owned changes never pass this relaxation.
func (a *Authority) RefreshFromRemoteContaining(ctx context.Context, expectedBranch string, expectedHead string) (RemoteDescriptor, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.git.refreshFromRemoteWithServiceDescendants(ctx, expectedBranch, expectedHead, true)
}

func (a *Authority) AppendEvidence(ctx context.Context, evidence domain.ValidationEvidence) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.prepareOwnedMutation(ctx); err != nil {
		return err
	}
	existing, err := a.readEvidenceAtHead(ctx)
	if err != nil {
		return err
	}
	updated, changed := upsertEvidence(existing, evidence)
	if !changed {
		return nil
	}
	payload, err := marshalNDJSON(updated)
	if err != nil {
		return err
	}
	return a.publishOwnedFile(ctx, defaultEvidenceFile, payload, fmt.Sprintf("coordination: upsert validation evidence for %s", evidence.Provider.ID))
}

// prepareOwnedMutation is shared by the narrowly declared service-owned
// writers. A dedicated service worktree must be clean before any commit, so a
// task event can never accidentally include an Agent-owned document.
func (a *Authority) prepareOwnedMutation(ctx context.Context) error {
	if err := a.git.ensureSynchronized(ctx); err != nil {
		return err
	}
	staged, err := a.git.hasDiff(ctx, "--cached")
	if err != nil {
		return err
	}
	if staged {
		return fmt.Errorf("docs-repo has staged changes; refusing to include unrelated files in an authority commit")
	}
	dirty, err := a.git.hasPathChanges(ctx, ".")
	if err != nil {
		return err
	}
	if dirty {
		return fmt.Errorf("docs-repo service worktree has uncommitted changes; refusing service-owned commit")
	}
	return nil
}

// upsertEvidence is the pure calibration-slot transition. It preserves the
// content-addressed no-op for duplicate conclusions and replaces only the
// latest record in the same project/key/language slot.
func upsertEvidence(existing []domain.ValidationEvidence, evidence domain.ValidationEvidence) ([]domain.ValidationEvidence, bool) {
	fingerprint := evidence.ObservationFingerprint()
	for _, record := range existing {
		if record.ObservationFingerprint() == fingerprint {
			return existing, false
		}
	}
	slot := evidence.ObservationSlotFingerprint()
	replaced := false
	for index, record := range existing {
		if record.ObservationSlotFingerprint() == slot {
			existing[index] = evidence
			replaced = true
			break
		}
	}
	if !replaced {
		existing = append(existing, evidence)
	}
	return existing, true
}

// publishOwnedFile is deliberately private. Public Authority methods name a
// concrete artifact contract; callers cannot choose an arbitrary docs-repo
// path and thereby bypass Agent ownership.
func (a *Authority) publishOwnedFile(ctx context.Context, path string, payload []byte, message string) error {
	if !isServiceOwnedPath(path) {
		return fmt.Errorf("service-owned path %q is not allowed", path)
	}
	absolute := filepath.Join(a.root, filepath.FromSlash(path))
	if err := writeAtomicFile(absolute, payload); err != nil {
		return err
	}
	path = filepath.ToSlash(path)
	if _, err := a.git.run(ctx, "add", "--", path); err != nil {
		return err
	}
	if _, err := a.git.run(ctx,
		"-c", "user.name="+a.git.authorName,
		"-c", "user.email="+a.git.authorMail,
		"commit", "--only", "-m", message, "--", path,
	); err != nil {
		return err
	}
	if !a.git.local {
		if _, err := a.git.run(ctx, "push", a.git.remote, "HEAD:refs/heads/"+a.git.branch); err != nil {
			return fmt.Errorf("authority commit was created locally but push failed; it is not shared truth until push succeeds: %w", err)
		}
	}
	return a.git.ensureSynchronized(ctx)
}

func isServiceOwnedPath(path string) bool {
	canonical := filepath.ToSlash(path)
	if canonical == defaultEvidenceFile {
		return true
	}
	parts := strings.Split(canonical, "/")
	if len(parts) != 6 || parts[0] != "coordination" || parts[1] != "tasks" || parts[5] != "events.ndjson" {
		return false
	}
	return collaborationdomain.TaskRef{
		RepositoryID: collaborationdomain.RepositoryID(parts[2]),
		ServiceID:    collaborationdomain.ServiceID(parts[3]),
		TaskID:       parts[4],
	}.Validate() == nil
}

func writeAtomicFile(path string, payload []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+"-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := temporary.Write(payload); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func marshalNDJSON[T any](records []T) ([]byte, error) {
	var payload strings.Builder
	encoder := json.NewEncoder(&payload)
	for _, record := range records {
		if err := encoder.Encode(record); err != nil {
			return nil, err
		}
	}
	return []byte(payload.String()), nil
}

// AppendTaskLifecycle is a service-owned, append-only Task event path. It is
// intentionally not a generic document writer and cannot alter a proposal.
func (a *Authority) AppendTaskLifecycle(ctx context.Context, event collaborationdomain.TaskLifecycleEvent) error {
	if err := event.Validate(); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.prepareOwnedMutation(ctx); err != nil {
		return err
	}
	existing, err := a.readTaskLifecycleAtHead(ctx, event.Task)
	if err != nil {
		return err
	}
	for _, current := range existing {
		// Only a same-type, same-identity event is an idempotent retry; a
		// different event type is a deliberate lifecycle transition
		// (verified -> claimed -> completed) and must be appended.
		if current.Type == event.Type && current.VerificationIdentity() == event.VerificationIdentity() {
			return nil
		}
	}
	payload, err := marshalNDJSON(append(existing, event))
	if err != nil {
		return err
	}
	return a.publishOwnedFile(ctx, collaborationdomain.TaskLifecyclePath(event.Task), payload, "coordination: verify task "+event.Task.TaskID)
}

func (a *Authority) readTaskLifecycleAtHead(ctx context.Context, task collaborationdomain.TaskRef) ([]collaborationdomain.TaskLifecycleEvent, error) {
	path := collaborationdomain.TaskLifecyclePath(task)
	exists, err := a.git.hasPathAtHead(ctx, path)
	if err != nil {
		return nil, err
	}
	if !exists {
		return []collaborationdomain.TaskLifecycleEvent{}, nil
	}
	payload, err := a.git.run(ctx, "show", "HEAD:"+path)
	if err != nil {
		return nil, err
	}
	records := make([]collaborationdomain.TaskLifecycleEvent, 0)
	scanner := bufio.NewScanner(strings.NewReader(payload))
	scanner.Buffer(make([]byte, 1024), 64<<10)
	for scanner.Scan() {
		var event collaborationdomain.TaskLifecycleEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return nil, err
		}
		if err := event.Validate(); err != nil || event.Task != task {
			return nil, fmt.Errorf("invalid task lifecycle event at %q", path)
		}
		records = append(records, event)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

func (a *Authority) ListEvidence(ctx context.Context) ([]domain.ValidationEvidence, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.git.ensureSynchronized(ctx); err != nil {
		return nil, err
	}
	return a.readEvidenceAtHead(ctx)
}

func (a *Authority) readEvidenceAtHead(ctx context.Context) ([]domain.ValidationEvidence, error) {
	path := filepath.ToSlash(defaultEvidenceFile)
	exists, err := a.git.hasPathAtHead(ctx, path)
	if err != nil {
		return nil, err
	}
	if !exists {
		return []domain.ValidationEvidence{}, nil
	}
	payload, err := a.git.run(ctx, "show", "HEAD:"+path)
	if err != nil {
		return nil, err
	}

	records := make([]domain.ValidationEvidence, 0)
	scanner := bufio.NewScanner(strings.NewReader(payload))
	scanner.Buffer(make([]byte, 1024), 64<<10)
	for scanner.Scan() {
		var evidence domain.ValidationEvidence
		if err := json.Unmarshal(scanner.Bytes(), &evidence); err != nil {
			return nil, err
		}
		records = append(records, evidence)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return records, nil
}
