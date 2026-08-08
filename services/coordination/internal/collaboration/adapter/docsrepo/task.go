package docsrepo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/port"
	sharedocsrepo "github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
)

var _ port.TaskStore = (*TaskStore)(nil)

type taskLifecycleWriter interface {
	AppendTaskLifecycle(context.Context, domain.TaskLifecycleEvent) error
}

// TaskStore keeps the ownership split at the persistence edge: proposal reads
// use the shared Git snapshot while lifecycle writes use only the Authority's
// concrete service-owned Task event method.
type TaskStore struct {
	repository *sharedocsrepo.Repository
	writer     taskLifecycleWriter
	auth       port.TaskEventAuthenticator
}

func NewTaskStore(repository *sharedocsrepo.Repository, writer taskLifecycleWriter, auth port.TaskEventAuthenticator) (*TaskStore, error) {
	if repository == nil || writer == nil || auth == nil {
		return nil, fmt.Errorf("task store requires docs-repo read, lifecycle write, and event verification authorities")
	}
	return &TaskStore{repository: repository, writer: writer, auth: auth}, nil
}

func (s *TaskStore) ReadProposal(ctx context.Context, task domain.TaskRef) (domain.TaskProposalRecord, bool, error) {
	if err := task.Validate(); err != nil {
		return domain.TaskProposalRecord{}, false, err
	}
	path := domain.TaskProposalPath(task)
	payload, exists, err := s.repository.ReadFileAtHead(ctx, path)
	if err != nil || !exists {
		return domain.TaskProposalRecord{}, exists, err
	}
	var proposal domain.TaskProposal
	if err := decodeStrictJSON(payload, &proposal); err != nil {
		return domain.TaskProposalRecord{}, false, fmt.Errorf("decode task proposal %q: %w", path, err)
	}
	if err := proposal.Validate(); err != nil {
		return domain.TaskProposalRecord{}, false, err
	}
	if proposal.Task != task {
		return domain.TaskProposalRecord{}, false, fmt.Errorf("task proposal path %q disagrees with task identity", path)
	}
	sum := sha256.Sum256(payload)
	return domain.TaskProposalRecord{Proposal: proposal, ContentSHA256: hex.EncodeToString(sum[:])}, true, nil
}

func (s *TaskStore) ListLifecycle(ctx context.Context, task domain.TaskRef) ([]domain.TaskLifecycleEvent, error) {
	if err := task.Validate(); err != nil {
		return nil, err
	}
	path := domain.TaskLifecyclePath(task)
	payload, exists, err := s.repository.ReadFileAtHead(ctx, path)
	if err != nil || !exists {
		return []domain.TaskLifecycleEvent{}, err
	}
	records := make([]domain.TaskLifecycleEvent, 0)
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	for {
		var event domain.TaskLifecycleEvent
		err := decoder.Decode(&event)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("decode task lifecycle %q: %w", path, err)
		}
		if err := event.Validate(); err != nil || event.Task != task {
			return nil, fmt.Errorf("invalid task lifecycle event at %q", path)
		}
		if err := s.auth.VerifyTaskEvent(event); err != nil {
			return nil, fmt.Errorf("untrusted task lifecycle event at %q: %w", path, err)
		}
		records = append(records, event)
	}
	return records, nil
}

func (s *TaskStore) AppendLifecycle(ctx context.Context, event domain.TaskLifecycleEvent) error {
	return s.writer.AppendTaskLifecycle(ctx, event)
}
