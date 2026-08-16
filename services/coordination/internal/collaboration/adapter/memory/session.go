package memory

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/port"
)

var _ port.LiveSessionStore = (*SessionStore)(nil)

// SessionStore is the in-memory TTL live-session authority. A restart advances
// the coordinator epoch and invalidates every outstanding session credential;
// sessions are never reconstructed from Git or filesystem state.
type SessionStore struct {
	mu          sync.Mutex
	clock       Clock
	minTTL      time.Duration
	maxTTL      time.Duration
	epoch       uint64
	nextFence   uint64
	sessions    map[domain.SessionRef]domain.Session
}

func NewSessionStore(epoch uint64, minTTL time.Duration, maxTTL time.Duration, clock Clock) (*SessionStore, error) {
	if epoch == 0 || minTTL <= 0 || maxTTL < minTTL || clock == nil {
		return nil, fmt.Errorf("invalid session store configuration")
	}
	return &SessionStore{
		clock: clock, minTTL: minTTL, maxTTL: maxTTL, epoch: epoch,
		sessions: make(map[domain.SessionRef]domain.Session),
	}, nil
}

func (s *SessionStore) Register(ctx context.Context, request domain.SessionRegisterRequest) (domain.Session, error) {
	if err := contextError(ctx); err != nil {
		return domain.Session{}, err
	}
	if err := request.Validate(); err != nil {
		return domain.Session{}, err
	}
	if err := s.validateTTL(request.TTL); err != nil {
		return domain.Session{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	s.removeExpired(now)
	if _, exists := s.sessions[request.Ref]; exists {
		return domain.Session{}, domain.ErrSessionExists
	}
	s.nextFence++
	session := domain.Session{
		Ref: request.Ref, Owner: request.Owner, FencingToken: s.nextFence, CoordinatorEpoch: s.epoch,
		StartedAt: now, LastHeartbeat: now, ExpiresAt: now.Add(request.TTL),
	}
	s.sessions[request.Ref] = session
	return session, nil
}

func (s *SessionStore) Heartbeat(ctx context.Context, heartbeat domain.SessionHeartbeat) (domain.Session, error) {
	if err := contextError(ctx); err != nil {
		return domain.Session{}, err
	}
	if err := heartbeat.Validate(); err != nil {
		return domain.Session{}, err
	}
	if err := s.validateTTL(heartbeat.TTL); err != nil {
		return domain.Session{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	ref, err := s.findRef(heartbeat.Credential.SessionID)
	if err != nil {
		return domain.Session{}, err
	}
	session, ok := s.sessions[ref]
	if !ok {
		return domain.Session{}, domain.ErrSessionUnknown
	}
	if !now.Before(session.ExpiresAt) {
		delete(s.sessions, ref)
		return domain.Session{}, domain.ErrSessionExpired
	}
	if session.Credential() != heartbeat.Credential {
		return domain.Session{}, domain.ErrSessionStale
	}
	session.LastHeartbeat = now
	session.ExpiresAt = now.Add(heartbeat.TTL)
	s.sessions[ref] = session
	return session, nil
}

func (s *SessionStore) Close(ctx context.Context, credential domain.SessionCredential) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	if err := credential.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ref, err := s.findRef(credential.SessionID)
	if err != nil {
		return nil // idempotent close: unknown session is already closed
	}
	session, ok := s.sessions[ref]
	if !ok {
		return nil
	}
	if session.Credential() != credential {
		return domain.ErrSessionStale
	}
	delete(s.sessions, ref)
	return nil
}

func (s *SessionStore) Get(ctx context.Context, ref domain.SessionRef) (domain.Session, bool, error) {
	if err := contextError(ctx); err != nil {
		return domain.Session{}, false, err
	}
	if err := ref.Validate(); err != nil {
		return domain.Session{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeExpired(s.clock())
	session, ok := s.sessions[ref]
	return session, ok, nil
}

func (s *SessionStore) List(ctx context.Context) ([]domain.Session, error) {
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeExpired(s.clock())
	sessions := make([]domain.Session, 0, len(s.sessions))
	for _, session := range s.sessions {
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].Ref.RepositoryID != sessions[j].Ref.RepositoryID {
			return sessions[i].Ref.RepositoryID < sessions[j].Ref.RepositoryID
		}
		return sessions[i].Ref.SessionID < sessions[j].Ref.SessionID
	})
	return sessions, nil
}

func (s *SessionStore) validateTTL(ttl time.Duration) error {
	if ttl < s.minTTL || ttl > s.maxTTL {
		return fmt.Errorf("session TTL must be between %s and %s", s.minTTL, s.maxTTL)
	}
	return nil
}

func (s *SessionStore) findRef(sessionID string) (domain.SessionRef, error) {
	for ref := range s.sessions {
		if ref.SessionID == sessionID {
			return ref, nil
		}
	}
	return domain.SessionRef{}, domain.ErrSessionUnknown
}

func (s *SessionStore) removeExpired(now time.Time) {
	for ref, session := range s.sessions {
		if !now.Before(session.ExpiresAt) {
			delete(s.sessions, ref)
		}
	}
}
