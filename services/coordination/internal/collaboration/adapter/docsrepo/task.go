package docsrepo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"sort"
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

func (s *TaskStore) ListProposals(ctx context.Context) ([]domain.TaskProposalRecord, error) {
	snapshots, err := s.repository.ReadListedFilesAtHead(ctx, "tasks")
	if err != nil {
		return nil, err
	}
	records := make([]domain.TaskProposalRecord, 0, len(snapshots))
	for _, snapshot := range snapshots {
		ref, ok, err := taskRefFromProposalPath(snapshot.Path)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if domain.TaskProposalPath(ref) != snapshot.Path {
			return nil, fmt.Errorf("task proposal path %q disagrees with task identity", snapshot.Path)
		}
		record, err := decodeProposalRecord(snapshot.Content, snapshot.Path, ref)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool {
		return taskRefKey(records[i].Proposal.Task) < taskRefKey(records[j].Proposal.Task)
	})
	return records, nil
}

func taskRefFromProposalPath(path string) (domain.TaskRef, bool, error) {
	parts := strings.Split(filepath.ToSlash(path), "/")
	if len(parts) != 5 || parts[0] != "tasks" || parts[4] != "proposal.json" {
		return domain.TaskRef{}, false, nil
	}
	ref := domain.TaskRef{
		RepositoryID: domain.RepositoryID(parts[1]),
		ServiceID:    domain.ServiceID(parts[2]),
		TaskID:       parts[3],
	}
	if err := ref.Validate(); err != nil {
		return domain.TaskRef{}, false, fmt.Errorf("invalid task proposal path %q: %w", path, err)
	}
	return ref, true, nil
}

func taskRefKey(ref domain.TaskRef) string {
	return string(ref.RepositoryID) + "\x00" + string(ref.ServiceID) + "\x00" + ref.TaskID
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
	record, err := decodeProposalRecord(payload, path, task)
	if err != nil {
		return domain.TaskProposalRecord{}, false, err
	}
	return record, true, nil
}

func decodeProposalRecord(payload []byte, path string, task domain.TaskRef) (domain.TaskProposalRecord, error) {
	var proposal domain.TaskProposal
	if err := decodeStrictJSON(payload, &proposal); err != nil {
		return domain.TaskProposalRecord{}, fmt.Errorf("decode task proposal %q: %w", path, err)
	}
	if err := proposal.Validate(); err != nil {
		return domain.TaskProposalRecord{}, err
	}
	if proposal.Task != task {
		return domain.TaskProposalRecord{}, fmt.Errorf("task proposal path %q disagrees with task identity", path)
	}
	sum := sha256.Sum256(payload)
	return domain.TaskProposalRecord{Proposal: proposal, ContentSHA256: hex.EncodeToString(sum[:])}, nil
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
	return s.decodeLifecycleEvents(payload, path, task)
}

// ListLifecycleStreams reads every service-owned event file from one
// synchronized HEAD. Task listing uses it so N tasks cost one remote head
// check + one path listing + N `git show` calls instead of 2N `ls-tree`+`show`
// calls under N separate synchronizations.
func (s *TaskStore) ListLifecycleStreams(ctx context.Context) (map[domain.TaskRef][]domain.TaskLifecycleEvent, error) {
	snapshots, err := s.repository.ReadListedFilesAtHead(ctx, "coordination/tasks")
	if err != nil {
		return nil, err
	}
	streams := make(map[domain.TaskRef][]domain.TaskLifecycleEvent, len(snapshots))
	for _, snapshot := range snapshots {
		ref, ok, err := taskRefFromLifecyclePath(snapshot.Path)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		events, err := s.decodeLifecycleEvents(snapshot.Content, snapshot.Path, ref)
		if err != nil {
			return nil, err
		}
		streams[ref] = events
	}
	return streams, nil
}

func taskRefFromLifecyclePath(path string) (domain.TaskRef, bool, error) {
	parts := strings.Split(filepath.ToSlash(path), "/")
	if len(parts) != 6 || parts[0] != "coordination" || parts[1] != "tasks" || parts[5] != "events.ndjson" {
		return domain.TaskRef{}, false, nil
	}
	ref := domain.TaskRef{
		RepositoryID: domain.RepositoryID(parts[2]),
		ServiceID:    domain.ServiceID(parts[3]),
		TaskID:       parts[4],
	}
	if err := ref.Validate(); err != nil {
		return domain.TaskRef{}, false, fmt.Errorf("invalid task lifecycle path %q: %w", path, err)
	}
	if domain.TaskLifecyclePath(ref) != path {
		return domain.TaskRef{}, false, fmt.Errorf("task lifecycle path %q disagrees with task identity", path)
	}
	return ref, true, nil
}

func (s *TaskStore) decodeLifecycleEvents(payload []byte, path string, task domain.TaskRef) ([]domain.TaskLifecycleEvent, error) {
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
	if err := domain.ValidateLifecycleChain(records); err != nil {
		return nil, fmt.Errorf("invalid task lifecycle chain at %q: %w", path, err)
	}
	return records, nil
}

func (s *TaskStore) AppendLifecycle(ctx context.Context, event domain.TaskLifecycleEvent) error {
	return s.writer.AppendTaskLifecycle(ctx, event)
}
