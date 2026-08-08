package signing

import (
	"crypto/ed25519"
	"strings"
	"testing"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

func TestTaskEventSignatureRejectsTamperedGitRecord(t *testing.T) {
	private := ed25519.NewKeyFromSeed([]byte("01234567890123456789012345678901"))
	authenticator, err := NewEd25519TaskEventAuthenticator("coordination-task-v1", private)
	if err != nil {
		t.Fatal(err)
	}
	event := domain.TaskLifecycleEvent{
		SchemaVersion:   domain.TaskEventSchemaVersion,
		Task:            domain.TaskRef{RepositoryID: "repo-a", ServiceID: "api", TaskID: "task-1"},
		Type:            "verified",
		ProposalSHA256:  strings.Repeat("a", 64),
		VerifiedHeadSHA: strings.Repeat("b", 40),
		RecordedAt:      time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC),
	}
	signed, err := authenticator.SignTaskEvent(event)
	if err != nil {
		t.Fatal(err)
	}
	if err := authenticator.VerifyTaskEvent(signed); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	signed.ProposalSHA256 = strings.Repeat("c", 64)
	if err := authenticator.VerifyTaskEvent(signed); err == nil {
		t.Fatal("tampered task event was trusted")
	}
}
