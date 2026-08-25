package signing

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

func TestTaskEventMultiKeyVerificationAfterRotation(t *testing.T) {
	oldPrivate := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, ed25519.SeedSize))
	newPrivate := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{8}, ed25519.SeedSize))
	oldPublic := oldPrivate.Public().(ed25519.PublicKey)
	oldAuthenticator, err := NewEd25519TaskEventAuthenticator("old-key", oldPrivate)
	if err != nil {
		t.Fatal(err)
	}
	rotatedAuthenticator, err := NewEd25519TaskEventAuthenticator("new-key", newPrivate,
		"old-key:"+base64.RawStdEncoding.EncodeToString(oldPublic),
	)
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
	if err := domain.LinkLifecycleEvent(nil, &event); err != nil {
		t.Fatal(err)
	}
	signed, err := oldAuthenticator.SignTaskEvent(event)
	if err != nil {
		t.Fatal(err)
	}
	if err := rotatedAuthenticator.VerifyTaskEvent(signed); err != nil {
		t.Fatalf("rotated authenticator rejected old event: %v", err)
	}
	untrustedAuthenticator, err := NewEd25519TaskEventAuthenticator("new-key", newPrivate)
	if err != nil {
		t.Fatal(err)
	}
	if err := untrustedAuthenticator.VerifyTaskEvent(signed); err == nil {
		t.Fatal("authenticator without old public key trusted an old event")
	}
}

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
	if err := domain.LinkLifecycleEvent(nil, &event); err != nil {
		t.Fatal(err)
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
