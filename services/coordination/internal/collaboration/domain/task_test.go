package domain

import (
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

func lifecycleEvent(eventType string, mutate func(*TaskLifecycleEvent)) TaskLifecycleEvent {
	event := TaskLifecycleEvent{
		SchemaVersion:   TaskEventSchemaVersion,
		Task:            taskRef(),
		Type:            eventType,
		ProposalSHA256:  testProposalSHA,
		VerifiedHeadSHA: testHeadSHA,
		RecordedAt:      time.Now().UTC().Truncate(time.Millisecond),
	}
	if mutate != nil {
		mutate(&event)
	}
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

	valid("verified minimal", lifecycleEvent("verified", nil))
	valid("claimed with claimedBy", lifecycleEvent("claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }))
	valid("completed with completedBy", lifecycleEvent("completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" }))
	valid("completed with optional head", lifecycleEvent("completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2"; e.CompletedHeadSHA = testHeadSHA }))

	invalid("verified must not carry claimedBy", lifecycleEvent("verified", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }))
	invalid("verified must not carry completedBy", lifecycleEvent("verified", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" }))
	invalid("unsupported type", lifecycleEvent("exploded", nil))
	invalid("claimed requires claimedBy", lifecycleEvent("claimed", nil))
	invalid("claimed must not carry completedBy", lifecycleEvent("claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2"; e.CompletedBy = "agent-2" }))
	invalid("claimed rejected invalid identifier", lifecycleEvent("claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "bad/id" }))
	invalid("completed requires completedBy", lifecycleEvent("completed", nil))
	invalid("completed must not carry claimedBy", lifecycleEvent("completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2"; e.ClaimedBy = "agent-2" }))
	invalid("completed rejected invalid head", lifecycleEvent("completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2"; e.CompletedHeadSHA = "not-a-sha" }))
	invalid("completed rejected invalid identifier", lifecycleEvent("completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "x y" }))
}

func TestSigningPayloadIsStableAcrossTypes(t *testing.T) {
	withSigner := func(event TaskLifecycleEvent) TaskLifecycleEvent {
		event.SignerKeyID = "coordination-task-v1"
		return event
	}
	payload, err := withSigner(lifecycleEvent("claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })).SigningPayload()
	if err != nil {
		t.Fatal(err)
	}
	payloadAgain, err := withSigner(lifecycleEvent("claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" })).SigningPayload()
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != string(payloadAgain) {
		t.Fatal("signing payload must be stable for the same event")
	}
	if !strings.Contains(string(payload), "agent-2") {
		t.Fatal("claimedBy must participate in the signing payload")
	}
	completedPayload, err := withSigner(lifecycleEvent("completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2" })).SigningPayload()
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
	verified := TaskStatusOf([]TaskLifecycleEvent{lifecycleEvent("verified", nil)})
	if verified.State != "verified" || verified.ProposalSHA256 != testProposalSHA || verified.VerifiedHeadSHA != testHeadSHA {
		t.Fatalf("verified status = %+v", verified)
	}
	claimed := TaskStatusOf([]TaskLifecycleEvent{
		lifecycleEvent("verified", nil),
		lifecycleEvent("claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }),
	})
	if claimed.State != "claimed" || claimed.ClaimedBy != "agent-2" {
		t.Fatalf("claimed status = %+v", claimed)
	}
	completed := TaskStatusOf([]TaskLifecycleEvent{
		lifecycleEvent("verified", nil),
		lifecycleEvent("claimed", func(e *TaskLifecycleEvent) { e.ClaimedBy = "agent-2" }),
		lifecycleEvent("completed", func(e *TaskLifecycleEvent) { e.CompletedBy = "agent-2"; e.CompletedHeadSHA = testHeadSHA }),
	})
	if completed.State != "completed" || completed.CompletedBy != "agent-2" || completed.CompletedHeadSHA != testHeadSHA {
		t.Fatalf("completed status = %+v", completed)
	}
}
