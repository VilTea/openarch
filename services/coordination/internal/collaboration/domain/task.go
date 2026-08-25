package domain

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/identity"
)

const (
	TaskProposalSchemaVersion = "1"
	TaskEventSchemaVersion    = "2"
	zeroEventHash             = "0000000000000000000000000000000000000000000000000000000000000000"
)

var (
	ErrTaskProposalMissing  = errors.New("task proposal is missing")
	ErrTaskProposalMismatch = errors.New("task proposal has changed after verification")
	ErrTaskAlreadyVerified  = errors.New("task has already been verified with different evidence")
	ErrTaskNotVerified      = errors.New("task is not verified for this proposal")
	ErrTaskAlreadyClaimed   = errors.New("task has already been claimed")
	ErrTaskNotClaimed       = errors.New("task is not claimed by this executor")
	ErrTaskAlreadyCompleted = errors.New("task has already been completed")
	ErrTaskLeaseNotHeld     = errors.New("task completion requires holding the semantic lease for the target")
	ErrTaskDependencyNotMet = errors.New("task dependencies are not completed")
	ErrTaskDependencyCycle  = errors.New("task dependency cycle detected")
)

// TaskRef binds every executable task to one declared service. It deliberately
// cannot represent a product-wide claim or an unscoped global task.
type TaskRef struct {
	RepositoryID RepositoryID `json:"repositoryId"`
	ServiceID    ServiceID    `json:"serviceId"`
	TaskID       string       `json:"taskId"`
}

func (ref TaskRef) Validate() error {
	if err := ref.RepositoryID.Validate(); err != nil {
		return err
	}
	if err := ref.ServiceID.Validate(); err != nil {
		return err
	}
	if err := identity.Validate(ref.TaskID); err != nil {
		return fmt.Errorf("taskId: %w", err)
	}
	return nil
}

func (ref TaskRef) Service() ServiceRef {
	return ServiceRef{RepositoryID: ref.RepositoryID, ID: ref.ServiceID}
}

func TaskProposalPath(ref TaskRef) string {
	return "tasks/" + string(ref.RepositoryID) + "/" + string(ref.ServiceID) + "/" + ref.TaskID + "/proposal.json"
}

func TaskLifecyclePath(ref TaskRef) string {
	return "coordination/tasks/" + string(ref.RepositoryID) + "/" + string(ref.ServiceID) + "/" + ref.TaskID + "/events.ndjson"
}

// TaskProposal is Agent-owned durable intent. Verification does not mutate it.
type TaskProposal struct {
	SchemaVersion string    `json:"schemaVersion"`
	Task          TaskRef   `json:"task"`
	Title         string    `json:"title"`
	Hypothesis    string    `json:"hypothesis"`
	RequestedBy   string    `json:"requestedBy"`
	DependsOn     []TaskRef `json:"dependsOn,omitempty"`
	Goal          string    `json:"goal,omitempty"`
	Scope         []string  `json:"scope,omitempty"`
	Constraints   []string  `json:"constraints,omitempty"`
	Verification  []string  `json:"verification,omitempty"`
	Deliverable   string    `json:"deliverable,omitempty"`
}

func (proposal TaskProposal) Validate() error {
	if proposal.SchemaVersion != TaskProposalSchemaVersion {
		return fmt.Errorf("task proposal schema must be %q", TaskProposalSchemaVersion)
	}
	if err := proposal.Task.Validate(); err != nil {
		return err
	}
	if title := strings.TrimSpace(proposal.Title); title == "" || len(title) > 240 {
		return errors.New("task proposal title must be 1..240 characters")
	}
	if hypothesis := strings.TrimSpace(proposal.Hypothesis); hypothesis == "" || len(hypothesis) > 2000 {
		return errors.New("task proposal hypothesis must be 1..2000 characters")
	}
	if err := identity.Validate(proposal.RequestedBy); err != nil {
		return fmt.Errorf("task proposal requestedBy: %w", err)
	}
	seen := make(map[TaskRef]bool, len(proposal.DependsOn))
	for _, dependency := range proposal.DependsOn {
		if err := dependency.Validate(); err != nil {
			return fmt.Errorf("task proposal dependsOn: %w", err)
		}
		if dependency == proposal.Task {
			return fmt.Errorf("task proposal must not depend on itself")
		}
		if seen[dependency] {
			return fmt.Errorf("task proposal dependsOn contains duplicate task")
		}
		seen[dependency] = true
	}
	if goal := strings.TrimSpace(proposal.Goal); len(goal) > 2000 {
		return errors.New("task proposal goal must be at most 2000 characters")
	}
	if deliverable := strings.TrimSpace(proposal.Deliverable); len(deliverable) > 2000 {
		return errors.New("task proposal deliverable must be at most 2000 characters")
	}
	for label, items := range map[string][]string{
		"scope":        proposal.Scope,
		"constraints":  proposal.Constraints,
		"verification": proposal.Verification,
	} {
		if len(items) > 20 {
			return fmt.Errorf("task proposal %s must have at most 20 items", label)
		}
		for _, item := range items {
			item = strings.TrimSpace(item)
			if item == "" || len(item) > 500 {
				return fmt.Errorf("task proposal %s items must be 1..500 characters", label)
			}
		}
	}
	return nil
}

type TaskProposalRecord struct {
	Proposal      TaskProposal
	ContentSHA256 string
}

func (record TaskProposalRecord) Validate() error {
	if err := record.Proposal.Validate(); err != nil {
		return err
	}
	return validateSHA256(record.ContentSHA256, "task proposal contentSha256")
}

// ValidateDependencyGraph rejects dependency cycles across all known task
// proposals. Missing dependencies are allowed at the graph level; they are
// enforced as not-completed when a task is claimed/completed.
func ValidateDependencyGraph(records []TaskProposalRecord) error {
	byTask := make(map[TaskRef]TaskProposal, len(records))
	for _, record := range records {
		byTask[record.Proposal.Task] = record.Proposal
	}
	const (
		visiting = 1
		visited  = 2
	)
	state := make(map[TaskRef]int, len(records))
	var visit func(TaskRef) error
	visit = func(ref TaskRef) error {
		switch state[ref] {
		case visiting:
			return ErrTaskDependencyCycle
		case visited:
			return nil
		}
		proposal, ok := byTask[ref]
		if !ok {
			return nil
		}
		state[ref] = visiting
		for _, dependency := range proposal.DependsOn {
			if err := visit(dependency); err != nil {
				return err
			}
		}
		state[ref] = visited
		return nil
	}
	for _, record := range records {
		if err := visit(record.Proposal.Task); err != nil {
			return err
		}
	}
	return nil
}

type TaskSubmission struct {
	Task    TaskRef `json:"task"`
	Branch  string  `json:"branch"`
	HeadSHA string  `json:"headSha"`
}

func (submission TaskSubmission) Validate() error {
	if err := submission.Task.Validate(); err != nil {
		return err
	}
	return validateRevision(submission.Branch, submission.HeadSHA)
}

// TaskLifecycleEvent is a schema v2 service-owned append-only record. Every
// event carries a sequence, its own canonical eventHash, and the hash of the
// previous event so the stream is a verifiable hash chain.
type TaskLifecycleEvent struct {
	SchemaVersion    string    `json:"schemaVersion"`
	Task             TaskRef   `json:"task"`
	Type             string    `json:"type"`
	ProposalSHA256   string    `json:"proposalSha256"`
	VerifiedHeadSHA  string    `json:"verifiedHeadSha"`
	Sequence         int64     `json:"sequence"`
	PrevEventHash    string    `json:"prevEventHash"`
	EventHash        string    `json:"eventHash"`
	RecordedAt       time.Time `json:"recordedAt"`
	SignerKeyID      string    `json:"signerKeyId"`
	Signature        string    `json:"signature"`
	ClaimedBy        string    `json:"claimedBy,omitempty"`
	CompletedBy      string    `json:"completedBy,omitempty"`
	LeaseID          string    `json:"leaseId,omitempty"`
	LocalHeadSHA     string    `json:"localHeadSHA,omitempty"`
	CompletedHeadSHA string    `json:"completedHeadSHA,omitempty"`
}

// taskEventHashFields is the canonical JSON used to derive eventHash. It must
// stay stable: field order is part of the contract.
type taskEventHashFields struct {
	SchemaVersion    string  `json:"schemaVersion"`
	Task             TaskRef `json:"task"`
	Type             string  `json:"type"`
	ProposalSHA256   string  `json:"proposalSha256"`
	VerifiedHeadSHA  string  `json:"verifiedHeadSha"`
	Sequence         int64   `json:"sequence"`
	PrevEventHash    string  `json:"prevEventHash"`
	SignerKeyID      string  `json:"signerKeyId"`
	RecordedAt       string  `json:"recordedAt"`
	ClaimedBy        string  `json:"claimedBy"`
	CompletedBy      string  `json:"completedBy"`
	LeaseID          string  `json:"leaseId"`
	LocalHeadSHA     string  `json:"localHeadSHA"`
	CompletedHeadSHA string  `json:"completedHeadSHA"`
}

// taskEventSigningFields adds eventHash to the canonical hash fields. The
// signature covers this payload, but not the signature field itself.
type taskEventSigningFields struct {
	taskEventHashFields
	EventHash string `json:"eventHash"`
}

func (event TaskLifecycleEvent) validateBody() error {
	if event.SchemaVersion != TaskEventSchemaVersion {
		return fmt.Errorf("task event schema must be %q", TaskEventSchemaVersion)
	}
	if err := event.Task.Validate(); err != nil {
		return err
	}
	if err := validateSHA256(event.ProposalSHA256, "task event proposalSha256"); err != nil {
		return err
	}
	if err := validateGitSHA(event.VerifiedHeadSHA, "task event verifiedHeadSha"); err != nil {
		return err
	}
	if event.RecordedAt.IsZero() {
		return errors.New("task event recordedAt is required")
	}
	switch event.Type {
	case "verified":
		return validateVerifiedEventFields(event)
	case "claimed":
		return validateClaimedEventFields(event)
	case "completed_local":
		return validateCompletedLocalEventFields(event)
	case "completed":
		return validateCompletedEventFields(event)
	default:
		return errors.New("unsupported task lifecycle event type")
	}
}

func (event TaskLifecycleEvent) validateLinkFields() error {
	if event.Sequence < 1 {
		return errors.New("task event sequence must be positive")
	}
	if err := validateSHA256(event.PrevEventHash, "task event prevEventHash"); err != nil {
		return err
	}
	if err := validateSHA256(event.EventHash, "task event eventHash"); err != nil {
		return err
	}
	return nil
}

func (event TaskLifecycleEvent) ComputeEventHash() (string, error) {
	if err := event.validateBody(); err != nil {
		return "", err
	}
	if event.Sequence < 1 {
		return "", errors.New("task event sequence must be positive")
	}
	if err := validateSHA256(event.PrevEventHash, "task event prevEventHash"); err != nil {
		return "", err
	}
	if err := identity.Validate(event.SignerKeyID); err != nil {
		return "", fmt.Errorf("task event signerKeyId: %w", err)
	}
	payload, err := json.Marshal(taskEventHashFields{
		SchemaVersion:    event.SchemaVersion,
		Task:             event.Task,
		Type:             event.Type,
		ProposalSHA256:   event.ProposalSHA256,
		VerifiedHeadSHA:  event.VerifiedHeadSHA,
		Sequence:         event.Sequence,
		PrevEventHash:    event.PrevEventHash,
		SignerKeyID:      event.SignerKeyID,
		RecordedAt:       event.RecordedAt.UTC().Format(time.RFC3339Nano),
		ClaimedBy:        event.ClaimedBy,
		CompletedBy:      event.CompletedBy,
		LeaseID:          event.LeaseID,
		LocalHeadSHA:     event.LocalHeadSHA,
		CompletedHeadSHA: event.CompletedHeadSHA,
	})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

func (event TaskLifecycleEvent) SigningPayload() ([]byte, error) {
	if err := event.validateBody(); err != nil {
		return nil, err
	}
	if err := event.validateLinkFields(); err != nil {
		return nil, err
	}
	if err := identity.Validate(event.SignerKeyID); err != nil {
		return nil, fmt.Errorf("task event signerKeyId: %w", err)
	}
	computed, err := event.ComputeEventHash()
	if err != nil {
		return nil, err
	}
	if computed != event.EventHash {
		return nil, errors.New("task event eventHash does not match canonical content")
	}
	hashFields, err := event.canonicalHashFields()
	if err != nil {
		return nil, err
	}
	return json.Marshal(taskEventSigningFields{
		taskEventHashFields: hashFields,
		EventHash:           event.EventHash,
	})
}

func (event TaskLifecycleEvent) canonicalHashFields() (taskEventHashFields, error) {
	if err := event.validateBody(); err != nil {
		return taskEventHashFields{}, err
	}
	if event.Sequence < 1 {
		return taskEventHashFields{}, errors.New("task event sequence must be positive")
	}
	if err := validateSHA256(event.PrevEventHash, "task event prevEventHash"); err != nil {
		return taskEventHashFields{}, err
	}
	if err := identity.Validate(event.SignerKeyID); err != nil {
		return taskEventHashFields{}, fmt.Errorf("task event signerKeyId: %w", err)
	}
	return taskEventHashFields{
		SchemaVersion:    event.SchemaVersion,
		Task:             event.Task,
		Type:             event.Type,
		ProposalSHA256:   event.ProposalSHA256,
		VerifiedHeadSHA:  event.VerifiedHeadSHA,
		Sequence:         event.Sequence,
		PrevEventHash:    event.PrevEventHash,
		SignerKeyID:      event.SignerKeyID,
		RecordedAt:       event.RecordedAt.UTC().Format(time.RFC3339Nano),
		ClaimedBy:        event.ClaimedBy,
		CompletedBy:      event.CompletedBy,
		LeaseID:          event.LeaseID,
		LocalHeadSHA:     event.LocalHeadSHA,
		CompletedHeadSHA: event.CompletedHeadSHA,
	}, nil
}

func validateVerifiedEventFields(event TaskLifecycleEvent) error {
	if event.ClaimedBy != "" || event.CompletedBy != "" || event.LeaseID != "" || event.LocalHeadSHA != "" || event.CompletedHeadSHA != "" {
		return errors.New("verified task event must not carry claim/completion fields")
	}
	return nil
}

func validateClaimedEventFields(event TaskLifecycleEvent) error {
	if event.CompletedBy != "" || event.LeaseID != "" || event.LocalHeadSHA != "" || event.CompletedHeadSHA != "" {
		return errors.New("claimed task event must not carry completion fields")
	}
	if err := identity.Validate(event.ClaimedBy); err != nil {
		return fmt.Errorf("task event claimedBy: %w", err)
	}
	return nil
}

func validateCompletedLocalEventFields(event TaskLifecycleEvent) error {
	if event.ClaimedBy != "" || event.CompletedHeadSHA != "" {
		return errors.New("completed_local task event must not carry claimedBy or completedHeadSHA")
	}
	if err := identity.Validate(event.CompletedBy); err != nil {
		return fmt.Errorf("task event completedBy: %w", err)
	}
	if err := validateLeaseID(event.LeaseID); err != nil {
		return err
	}
	return validateGitSHA(event.LocalHeadSHA, "task event localHeadSHA")
}

func validateCompletedEventFields(event TaskLifecycleEvent) error {
	if event.ClaimedBy != "" || event.LocalHeadSHA != "" {
		return errors.New("completed task event must not carry claimedBy or localHeadSHA")
	}
	if err := identity.Validate(event.CompletedBy); err != nil {
		return fmt.Errorf("task event completedBy: %w", err)
	}
	if err := validateLeaseID(event.LeaseID); err != nil {
		return err
	}
	return validateGitSHA(event.CompletedHeadSHA, "task event completedHeadSHA")
}

func (event TaskLifecycleEvent) ValidateUnsigned() error {
	if err := event.validateBody(); err != nil {
		return err
	}
	if err := event.validateLinkFields(); err != nil {
		return err
	}
	if err := identity.Validate(event.SignerKeyID); err != nil {
		return fmt.Errorf("task event signerKeyId: %w", err)
	}
	computed, err := event.ComputeEventHash()
	if err != nil {
		return err
	}
	if computed != event.EventHash {
		return errors.New("task event eventHash does not match canonical content")
	}
	return nil
}

func (event TaskLifecycleEvent) Validate() error {
	if err := event.ValidateUnsigned(); err != nil {
		return err
	}
	signature, err := base64.RawStdEncoding.DecodeString(event.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("task event signature is invalid")
	}
	return nil
}

// VerificationIdentity intentionally excludes the recording timestamp, chain
// link fields, and event hash so a retried submit is a content-addressed no-op
// instead of a second lifecycle transition. Executor identity is deliberately
// excluded here: the authority converges same-type events for one task, while
// the application layer re-reads the persisted status and rejects a
// conflicting executor.
func (event TaskLifecycleEvent) VerificationIdentity() string {
	return string(event.Task.RepositoryID) + "\x00" + string(event.Task.ServiceID) + "\x00" + event.Task.TaskID + "\x00" + event.ProposalSHA256 + "\x00" + event.VerifiedHeadSHA
}

// LinkLifecycleEvent sets the sequence and prevEventHash for the next event in
// an existing stream. The eventHash is intentionally not computed here because
// the signer key ID must be known first; SignTaskEvent computes it after
// assigning SignerKeyID.
func LinkLifecycleEvent(existing []TaskLifecycleEvent, event *TaskLifecycleEvent) error {
	if event == nil {
		return errors.New("task lifecycle event is required")
	}
	if err := ValidateLifecycleChain(existing); err != nil {
		return err
	}
	if err := event.validateBody(); err != nil {
		return err
	}
	event.Sequence = int64(len(existing) + 1)
	if len(existing) == 0 {
		event.PrevEventHash = zeroEventHash
	} else {
		previousHash, err := existing[len(existing)-1].ComputeEventHash()
		if err != nil {
			return err
		}
		event.PrevEventHash = previousHash
	}
	return nil
}

// ValidateLifecycleChain verifies the v2 hash chain and the legal
// verified -> claimed -> completed state machine. Signature verification is
// intentionally not here; adapters verify signatures with the trusted keys.
func ValidateLifecycleChain(events []TaskLifecycleEvent) error {
	if len(events) == 0 {
		return nil
	}
	var task *TaskRef
	for index, event := range events {
		if err := event.Validate(); err != nil {
			return fmt.Errorf("task lifecycle event %d: %w", index, err)
		}
		if event.Sequence != int64(index+1) {
			return fmt.Errorf("task lifecycle sequence = %d at index %d, want %d", event.Sequence, index, index+1)
		}
		if task == nil {
			ref := event.Task
			task = &ref
		} else if event.Task != *task {
			return fmt.Errorf("task lifecycle stream mixes task identities at index %d", index)
		}
		if index == 0 {
			if event.PrevEventHash != zeroEventHash {
				return errors.New("first task lifecycle event must use the zero prevEventHash")
			}
			if event.Type != "verified" {
				return fmt.Errorf("first task lifecycle event must be verified, got %q", event.Type)
			}
		} else {
			previousHash, err := events[index-1].ComputeEventHash()
			if err != nil {
				return err
			}
			if event.PrevEventHash != previousHash {
				return fmt.Errorf("task lifecycle event %d prevEventHash does not match previous event", index)
			}
			if err := validateLifecycleTransition(events[index-1].Type, event.Type); err != nil {
				return err
			}
			if event.ProposalSHA256 != events[0].ProposalSHA256 || event.VerifiedHeadSHA != events[0].VerifiedHeadSHA {
				return fmt.Errorf("task lifecycle event %d diverges from verified proposal/head identity", index)
			}
		}
	}
	return nil
}

func validateLifecycleTransition(previous string, next string) error {
	switch previous + "->" + next {
	case "verified->claimed", "claimed->completed_local", "completed_local->completed":
		return nil
	default:
		return fmt.Errorf("invalid task lifecycle transition %q", previous+"->"+next)
	}
}

type TaskStatus struct {
	Task             TaskRef `json:"task"`
	State            string  `json:"state"`
	ProposalSHA256   string  `json:"proposalSha256"`
	VerifiedHeadSHA  string  `json:"verifiedHeadSha,omitempty"`
	ClaimedBy        string  `json:"claimedBy,omitempty"`
	CompletedBy      string  `json:"completedBy,omitempty"`
	LeaseID          string  `json:"leaseId,omitempty"`
	LocalHeadSHA     string  `json:"localHeadSHA,omitempty"`
	CompletedHeadSHA string  `json:"completedHeadSHA,omitempty"`
}

// TaskSummary is the read-only projection returned by task listing. It joins
// the Agent-owned proposal with the latest service-owned lifecycle state.
type TaskSummary struct {
	Task           TaskRef    `json:"task"`
	Title          string     `json:"title"`
	Hypothesis     string     `json:"hypothesis"`
	RequestedBy    string     `json:"requestedBy"`
	ProposalSHA256 string     `json:"proposalSha256"`
	Status         TaskStatus `json:"status"`
}

func (summary TaskSummary) Validate() error {
	if err := summary.Task.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(summary.Title) == "" || strings.TrimSpace(summary.RequestedBy) == "" {
		return errors.New("task summary title and requestedBy are required")
	}
	if err := validateSHA256(summary.ProposalSHA256, "task summary proposalSha256"); err != nil {
		return err
	}
	if summary.Status.Task != summary.Task {
		return errors.New("task summary status does not match task identity")
	}
	return nil
}

// TaskDetail is the read-only projection returned by the single-task detail
// endpoint. It includes the full v2 event chain so callers can audit hashes
// and signatures without reading the docs-repo directly.
type TaskDetail struct {
	Task           TaskRef              `json:"task"`
	Title          string               `json:"title"`
	Hypothesis     string               `json:"hypothesis"`
	RequestedBy    string               `json:"requestedBy"`
	ProposalSHA256 string               `json:"proposalSha256"`
	DependsOn      []TaskRef            `json:"dependsOn,omitempty"`
	Goal           string               `json:"goal,omitempty"`
	Scope          []string             `json:"scope,omitempty"`
	Constraints    []string             `json:"constraints,omitempty"`
	Verification   []string             `json:"verification,omitempty"`
	Deliverable    string               `json:"deliverable,omitempty"`
	Status         TaskStatus           `json:"status"`
	Events         []TaskLifecycleEvent `json:"events"`
}

func (detail TaskDetail) Validate() error {
	if err := detail.Task.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(detail.Title) == "" || strings.TrimSpace(detail.RequestedBy) == "" {
		return errors.New("task detail title and requestedBy are required")
	}
	if err := validateSHA256(detail.ProposalSHA256, "task detail proposalSha256"); err != nil {
		return err
	}
	if detail.Status.Task != detail.Task {
		return errors.New("task detail status does not match task identity")
	}
	for _, event := range detail.Events {
		if event.Task != detail.Task {
			return errors.New("task detail event does not match task identity")
		}
	}
	return nil
}

// TaskStatusOf rebuilds the latest lifecycle state from the append-only event
// stream. The stream order is the authority:
// verified -> claimed -> completed_local -> completed.
func TaskStatusOf(events []TaskLifecycleEvent) TaskStatus {
	var status TaskStatus
	if len(events) == 0 {
		return TaskStatus{Task: TaskRef{}, State: "none"}
	}
	for _, event := range events {
		switch event.Type {
		case "verified":
			status = TaskStatus{Task: event.Task, State: "verified", ProposalSHA256: event.ProposalSHA256, VerifiedHeadSHA: event.VerifiedHeadSHA}
		case "claimed":
			status.State = "claimed"
			status.ClaimedBy = event.ClaimedBy
		case "completed_local":
			status.State = "completed_local"
			status.CompletedBy = event.CompletedBy
			status.LeaseID = event.LeaseID
			status.LocalHeadSHA = event.LocalHeadSHA
		case "completed":
			status.State = "completed"
			status.CompletedBy = event.CompletedBy
			status.LeaseID = event.LeaseID
			status.CompletedHeadSHA = event.CompletedHeadSHA
		}
	}
	return status
}

func validateRevision(branch string, headSHA string) error {
	branch = strings.TrimSpace(branch)
	if branch == "" || strings.HasPrefix(branch, "-") || strings.ContainsAny(branch, "\x00\r\n") || strings.Contains(branch, "..") {
		return errors.New("task submission branch must be a safe non-empty name")
	}
	return validateGitSHA(headSHA, "task submission headSha")
}

func validateLeaseID(value string) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "\x00\r\n") {
		return errors.New("task event leaseId must be a bounded non-empty identifier")
	}
	return nil
}

func validateGitSHA(value string, label string) error {
	sha := strings.TrimSpace(value)
	if len(sha) != 40 {
		return fmt.Errorf("%s must be a 40-character Git SHA-1", label)
	}
	if _, err := hex.DecodeString(sha); err != nil {
		return fmt.Errorf("%s must be hexadecimal", label)
	}
	return nil
}

func validateSHA256(value string, label string) error {
	sum := strings.TrimSpace(value)
	if len(sum) != 64 {
		return fmt.Errorf("%s must be a 64-character SHA-256", label)
	}
	if _, err := hex.DecodeString(sum); err != nil {
		return fmt.Errorf("%s must be hexadecimal", label)
	}
	return nil
}

// ValidateSHA256Hex and ValidateGitSHAHex expose the internal validators for
// application-layer claim/complete payloads.
func ValidateSHA256Hex(value string, label string) error { return validateSHA256(value, label) }
func ValidateGitSHAHex(value string, label string) error { return validateGitSHA(value, label) }
