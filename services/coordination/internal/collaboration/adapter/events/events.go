package events

import (
	"sync"
	"time"
)

// Event is a live coordination notification. It is an ephemeral signal, not a
// durable fact: durable state remains in the Git-backed authority and live
// liveness remains in LeaseStore/SessionStore. A restart or a slow consumer may
// lose events, which is acceptable for a notification channel.
type Event struct {
	Type         string    `json:"type"`
	RepositoryID string    `json:"repositoryId,omitempty"`
	ServiceID    string    `json:"serviceId,omitempty"`
	TaskID       string    `json:"taskId,omitempty"`
	SessionID    string    `json:"sessionId,omitempty"`
	Target       string    `json:"target,omitempty"`
	Timestamp    time.Time `json:"timestamp"`
}

// Publisher fans one event out to all subscribers. Subscribers are bounded;
// when a subscriber buffer is full the event is dropped for that subscriber
// rather than blocking a writer or unboundedly buffering memory.
type Publisher struct {
	mu          sync.Mutex
	subscribers map[chan Event]struct{}
}

func NewPublisher() *Publisher {
	return &Publisher{subscribers: make(map[chan Event]struct{})}
}

// Subscribe returns a bounded event channel and a cancel function. The channel
// is closed by the publisher only when cancel is called; consumers must treat
// closed channels as end-of-stream.
func (p *Publisher) Subscribe() (<-chan Event, func()) {
	channel := make(chan Event, 64)
	p.mu.Lock()
	p.subscribers[channel] = struct{}{}
	p.mu.Unlock()
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			p.mu.Lock()
			if _, ok := p.subscribers[channel]; ok {
				delete(p.subscribers, channel)
				close(channel)
			}
			p.mu.Unlock()
		})
	}
	return channel, cancel
}

// Publish delivers the event to every subscriber without blocking. It reports
// how many subscribers dropped the event because their buffers were full.
func (p *Publisher) Publish(event Event) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	dropped := 0
	for subscriber := range p.subscribers {
		select {
		case subscriber <- event:
		default:
			dropped++
		}
	}
	return dropped
}
