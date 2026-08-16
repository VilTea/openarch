package events_test

import (
	"sync"
	"testing"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/adapter/events"
)

func TestPublisherDeliversAndCancels(t *testing.T) {
	publisher := events.NewPublisher()
	channel, cancel := publisher.Subscribe()
	event := events.Event{Type: "lease.acquired", RepositoryID: "repo-main", Timestamp: time.Now().UTC()}
	if dropped := publisher.Publish(event); dropped != 0 {
		t.Fatalf("publish dropped %d events, want 0", dropped)
	}
	select {
	case got := <-channel:
		if got.Type != event.Type || got.RepositoryID != event.RepositoryID {
			t.Fatalf("received %+v, want %+v", got, event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for published event")
	}
	cancel()
	if _, ok := <-channel; ok {
		t.Fatal("cancel did not close the subscriber channel")
	}
}

func TestPublisherDropsForSlowSubscriberWithoutBlockingWriter(t *testing.T) {
	publisher := events.NewPublisher()
	channel, cancel := publisher.Subscribe()
	defer cancel()
	const eventCount = 100
	for i := 0; i < eventCount; i++ {
		publisher.Publish(events.Event{Type: "session.heartbeat", Timestamp: time.Now().UTC()})
	}
	// Buffer is 64: at least some events were dropped, and Publish never blocked.
	received := 0
	for {
		select {
		case _, ok := <-channel:
			if !ok {
				t.Fatal("channel closed unexpectedly")
			}
			received++
		default:
			if received > 64 {
				t.Fatalf("received %d events, exceeding the subscriber buffer", received)
			}
			if received == 0 {
				t.Fatal("no events received")
			}
			return
		}
	}
}

func TestPublisherConcurrentPublishAndSubscribe(t *testing.T) {
	publisher := events.NewPublisher()
	var wait sync.WaitGroup
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			channel, cancel := publisher.Subscribe()
			defer cancel()
			for j := 0; j < 50; j++ {
				publisher.Publish(events.Event{Type: "lease.renewed", Timestamp: time.Now().UTC()})
			}
			for j := 0; j < 50; j++ {
				select {
				case <-channel:
				case <-time.After(time.Second):
					t.Error("timed out draining subscriber")
					return
				}
			}
		}()
	}
	wait.Wait()
}
