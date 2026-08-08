package domain

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/identity"
)

const (
	TaskProposalSchemaVersion = "1"
	TaskEventSchemaVersion    = "1"
)

var (
	ErrTaskProposalMissing  = errors.New("task proposal is missing")
	ErrTaskAlreadyVerified  = errors.New("task has already been verified with different evidence")
	ErrTaskNotVerified      = errors.New("task is not verified for this proposal")
	ErrTaskAlreadyClaimed   = errors.New("task has already been claimed")
	ErrTaskNotClaimed       = errors.New("task is not claimed by this executor")
	ErrTaskAlreadyCompleted = errors.New("task has already been completed")
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
	SchemaVersion string  `json:"schemaVersion"`
	Task          TaskRef `json:"task"`
	Title         string  `json:"title"`
	Hypothesis    string  `json:"hypothesis"`
	RequestedBy   string  `json:"requestedBy"`
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

type TaskLifecycleEvent struct {
	SchemaVersion   string    `json:"schemaVersion"`
	Task            TaskRef   `json:"task"`
	Type            string    `json:"type"`
	ProposalSHA256  string    `json:"proposalSha256"`
	VerifiedHeadSHA string    `json:"verifiedHeadSha"`
	RecordedAt      time.Time `json:"recordedAt"`
	SignerKeyID     string    `json:"signerKeyId"`
	Signature       string    `json:"signature"`
	ClaimedBy       string    `json:"claimedBy,omitempty"`
	CompletedBy     string    `json:"completedBy,omitempty"`
	CompletedHeadSHA string   `json:"completedHeadSHA,omitempty"`
}

func (event TaskLifecycleEvent) Validate() error {
	if err := event.ValidateUnsigned(); err != nil {
		return err
	}
	if err := identity.Validate(event.SignerKeyID); err != nil {
		return fmt.Errorf("task event signerKeyId: %w", err)
	}
	signature, err := base64.RawStdEncoding.DecodeString(event.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("task event signature is invalid")
	}
	return nil
}

func validateVerifiedEventFields(event TaskLifecycleEvent) error {
	if event.ClaimedBy != "" || event.CompletedBy != "" || event.CompletedHeadSHA != "" {
		return errors.New("verified task event must not carry claim/completion fields")
	}
	return nil
}

func validateClaimedEventFields(event TaskLifecycleEvent) error {
	if event.CompletedBy != "" || event.CompletedHeadSHA != "" {
		return errors.New("claimed task event must not carry completion fields")
	}
	if err := identity.Validate(event.ClaimedBy); err != nil {
		return fmt.Errorf("task event claimedBy: %w", err)
	}
	return nil
}

func validateCompletedEventFields(event TaskLifecycleEvent) error {
	if event.ClaimedBy != "" {
		return errors.New("completed task event must not carry a claimedBy field")
	}
	if err := identity.Validate(event.CompletedBy); err != nil {
		return fmt.Errorf("task event completedBy: %w", err)
	}
	if completedHead := strings.TrimSpace(event.CompletedHeadSHA); completedHead != "" {
		if err := validateGitSHA(completedHead, "task event completedHeadSHA"); err != nil {
			return err
		}
	}
	return nil
}

func (event TaskLifecycleEvent) ValidateUnsigned() error {
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
	case "completed":
		return validateCompletedEventFields(event)
	default:
		return errors.New("unsupported task lifecycle event type")
	}
}

func (event TaskLifecycleEvent) SigningPayload() ([]byte, error) {
	if err := event.ValidateUnsigned(); err != nil {
		return nil, err
	}
	if err := identity.Validate(event.SignerKeyID); err != nil {
		return nil, fmt.Errorf("task event signerKeyId: %w", err)
	}
	// The unified payload includes every association field (empty values stay in
	// the serialization) so the same event always signs identically.
	return []byte(strings.Join([]string{
		event.SchemaVersion,
		string(event.Task.RepositoryID),
		string(event.Task.ServiceID),
		event.Task.TaskID,
		event.Type,
		event.ProposalSHA256,
		event.VerifiedHeadSHA,
		event.ClaimedBy,
		event.CompletedBy,
		event.CompletedHeadSHA,
		event.RecordedAt.UTC().Format(time.RFC3339Nano),
		event.SignerKeyID,
	}, "\x00")), nil
}

// VerificationIdentity intentionally excludes the recording timestamp so a
// retried submit is a content-addressed no-op instead of a second lifecycle
// transition.
func (event TaskLifecycleEvent) VerificationIdentity() string {
	return string(event.Task.RepositoryID) + "\x00" + string(event.Task.ServiceID) + "\x00" + event.Task.TaskID + "\x00" + event.ProposalSHA256 + "\x00" + event.VerifiedHeadSHA
}

type TaskStatus struct {
	Task             TaskRef `json:"task"`
	State            string  `json:"state"`
	ProposalSHA256   string  `json:"proposalSha256"`
	VerifiedHeadSHA  string  `json:"verifiedHeadSha,omitempty"`
	ClaimedBy        string  `json:"claimedBy,omitempty"`
	CompletedBy      string  `json:"completedBy,omitempty"`
	CompletedHeadSHA string  `json:"completedHeadSHA,omitempty"`
}

// TaskStatusOf rebuilds the latest lifecycle state from the append-only event
// stream. The stream order is the authority: verified -> claimed -> completed.
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
		case "completed":
			status.State = "completed"
			status.CompletedBy = event.CompletedBy
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
