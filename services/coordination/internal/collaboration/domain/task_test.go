package domain

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

const (
	testProposalSHA = "73b6c4b02e65ae7deb4f6b681c7f72c6679dea3e7de1cb35d8c863bc52029701"
	testHeadSHA     = "20e4982edbc908c3fec8254c9410d91430f98ca5"
)

func taskRef() TaskRef {
	return TaskRef{RepositoryID: "repo-1", ServiceID: "svc-a", TaskID: "task-1"}
}

var testSignature = base64.RawStdEncoding.EncodeToString(make([]byte, 64))

// testEvent builds a schema v2 event linked after existing events. It sets a
// dummy signature only for full Validate() tests; ValidateUnsigned does not
// inspect the signature bytes.
func testEvent(existing []TaskLifecycleEvent, eventType string, mutate func(*TaskLifecycleEvent)) TaskLifecycleEvent {
	event := TaskLifecycleEvent{
		SchemaVersion:   TaskEventSchemaVersion,
		Task:            taskRef(),
		Type:            eventType,
		ProposalSHA256:  testProposalSHA,
		VerifiedHeadSHA: testHeadSHA,
		RecordedAt:      time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC),
		SignerKeyID:     "test-signer",
	}
	if mutate != nil {
		mutate(&event)
	}
	if (event.Type == "completed" || event.Type == "completed_local") && event.LeaseID == "" {
		event.LeaseID = "lease-1"
	}
	if event.Type == "completed" && event.CompletedHeadSHA == "" {
		event.CompletedHeadSHA = testHeadSHA
	}
	if event.Type == "completed_local" && event.LocalHeadSHA == "" {
		event.LocalHeadSHA = testHeadSHA
	}
	if err := LinkLifecycleEvent(existing, &event); err != nil {
		// Invalid-body fixtures are used by negative tests; they still need a
		// plausible link shape so ValidateUnsigned can report the body error.
		event.Sequence = int64(len(existing) + 1)
		if len(existing) == 0 {
			event.PrevEventHash = zeroEventHash
		} else if previousHash, hashErr := existing[len(existing)-1].ComputeEventHash(); hashErr == nil {
			event.PrevEventHash = previousHash
		} else {
			event.PrevEventHash = zeroEventHash
		}
		event.EventHash = strings.Repeat("0", 64)
		event.Signature = testSignature
		return event
	}
	hash, err := event.ComputeEventHash()
	if err != nil {
		panic(err)
	}
	event.EventHash = hash
	event.Signature = testSignature
	return event
}

func TestLifecycleEventTypeFieldConstraints(t *testing.T) {
	valid := func(name string, event TaskLifecycleEvent) {
		t.Helper()
		if err := event.ValidateUnsigned(); err != nil {
			t.Fatalf("%s: unexpected error: %v", name, err)
		}
	}
	invalid := func(name string, event TaskLifecycleEvent) {
		t.Helper()
		if err := event.ValidateUnsigned(); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}

	valid("verified minimal", testEvent(nil, "verified", nil))
	valid("claimed with claimedBy", testEvent(nil, "claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }))
	valid("completed_local with completedBy", testEvent(nil, "completed_local", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" }))
	valid("completed with completedBy", testEvent(nil, "completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" }))
	valid("completed with explicit head", testEvent(nil, "completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2"; e.CompletedHeadSHA = testHeadSHA }))

	invalid("verified must not carry claimedBy", testEvent(nil, "verified", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }))
	invalid("verified must not carry completedBy", testEvent(nil, "verified", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" }))
	invalid("unsupported type", testEvent(nil, "exploded", nil))
	invalid("claimed requires claimedBy", testEvent(nil, "claimed", nil))
	invalid("claimed must not carry completedBy", testEvent(nil, "claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2"; e.CompletedBy = "agent-2" }))
	invalid("claimed rejected invalid identifier", testEvent(nil, "claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "bad/id" }))
	invalid("completed_local requires completedBy", testEvent(nil, "completed_local", nil))
	invalid("completed_local must not carry completedHeadSHA", testEvent(nil, "completed_local", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2"; e.CompletedHeadSHA = testHeadSHA }))
	invalid("completed requires completedBy", testEvent(nil, "completed", nil))
	invalid("completed must not carry claimedBy", testEvent(nil, "completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2"; e.ClaimedBy = "agent-2" }))
	invalid("completed must not carry localHeadSHA", testEvent(nil, "completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2"; e.LocalHeadSHA = testHeadSHA }))
	invalid("completed rejected invalid head", testEvent(nil, "completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2"; e.CompletedHeadSHA = "not-a-sha" }))
	invalid("completed rejected invalid identifier", testEvent(nil, "completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "x y" }))
}

func TestSigningPayloadIsStableAcrossTypes(t *testing.T) {
	payload, err := testEvent(nil, "claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }).SigningPayload()
	if err != nil {
		t.Fatal(err)
	}
	payloadAgain, err := testEvent(nil, "claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }).SigningPayload()
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != string(payloadAgain) {
		t.Fatal("signing payload must be stable for the same event")
	}
	if !strings.Contains(string(payload), "agent-2") {
		t.Fatal("claimedBy must participate in the signing payload")
	}
	completedPayload, err := testEvent(nil, "completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" }).SigningPayload()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(completedPayload), "completed") {
		t.Fatal("event type must participate in the signing payload")
	}
}

func TestTaskStatusOfRebuildsLifecycle(t *testing.T) {
	empty := TaskStatusOf(nil)
	if empty.State != "none" {
		t.Fatalf("empty lifecycle state = %q, want none", empty.State)
	}
	verified := TaskStatusOf([]TaskLifecycleEvent{testEvent(nil, "verified", nil)})
	if verified.State != "verified" || verified.ProposalSHA256 != testProposalSHA || verified.VerifiedHeadSHA != testHeadSHA {
		t.Fatalf("verified status = %+v", verified)
	}
	claimed := TaskStatusOf([]TaskLifecycleEvent{
		testEvent(nil, "verified", nil),
		testEvent(nil, "claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }),
	})
	if claimed.State != "claimed" || claimed.ClaimedBy != "agent-2" {
		t.Fatalf("claimed status = %+v", claimed)
	}
	completedLocal := TaskStatusOf([]TaskLifecycleEvent{
		testEvent(nil, "verified", nil),
		testEvent(nil, "claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }),
		testEvent(nil, "completed_local", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" }),
	})
	if completedLocal.State != "completed_local" || completedLocal.CompletedBy != "agent-2" || completedLocal.LocalHeadSHA != testHeadSHA {
		t.Fatalf("completed_local status = %+v", completedLocal)
	}
	completed := TaskStatusOf([]TaskLifecycleEvent{
		testEvent(nil, "verified", nil),
		testEvent(nil, "claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }),
		testEvent(nil, "completed_local", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" }),
		testEvent(nil, "completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" }),
	})
	if completed.State != "completed" || completed.CompletedBy != "agent-2" || completed.CompletedHeadSHA != testHeadSHA {
		t.Fatalf("completed status = %+v", completed)
	}
}

func TestValidateLifecycleChainRejectsTampering(t *testing.T) {
	verified := testEvent(nil, "verified", nil)
	claimed := testEvent([]TaskLifecycleEvent{verified}, "claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })
	completedLocal := testEvent([]TaskLifecycleEvent{verified, claimed}, "completed_local", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" })
	completed := testEvent([]TaskLifecycleEvent{verified, claimed, completedLocal}, "completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" })

	if err := ValidateLifecycleChain([]TaskLifecycleEvent{verified, claimed, completedLocal, completed}); err != nil {
		t.Fatalf("valid chain rejected: %v", err)
	}
	reordered := []TaskLifecycleEvent{claimed, verified}
	if err := ValidateLifecycleChain(reordered); err == nil {
		t.Fatal("reordered chain accepted")
	}
	truncated := []TaskLifecycleEvent{verified, completed}
	if err := ValidateLifecycleChain(truncated); err == nil {
		t.Fatal("invalid transition accepted")
	}
	deleted := []TaskLifecycleEvent{verified}
	if err := ValidateLifecycleChain(deleted); err != nil {
		t.Fatalf("deleted tail should still be a valid prefix, got %v", err)
	}
}

func TestValidateDependencyGraphRejectsCycle(t *testing.T) {
	refA := TaskRef{RepositoryID: "repo-1", ServiceID: "svc-a", TaskID: "task-a"}
	refB := TaskRef{RepositoryID: "repo-1", ServiceID: "svc-a", TaskID: "task-b"}
	records := []TaskProposalRecord{
		{Proposal: TaskProposal{Task: refA, Title: "A", Hypothesis: "h", RequestedBy: "agent-a", DependsOn: []TaskRef{refB}}, ContentSHA256: strings.Repeat("a", 64)},
		{Proposal: TaskProposal{Task: refB, Title: "B", Hypothesis: "h", RequestedBy: "agent-b", DependsOn: []TaskRef{refA}}, ContentSHA256: strings.Repeat("b", 64)},
	}
	if err := ValidateDependencyGraph(records); err == nil {
		t.Fatal("dependency cycle accepted")
	}
}
