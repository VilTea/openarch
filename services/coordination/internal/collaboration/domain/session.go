package domain

import (
	"errors"
	"fmt"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/identity"
)

var (
	ErrSessionExists = errors.New("session is already registered")
	ErrSessionExpired = errors.New("session is expired")
	ErrSessionStale = errors.New("session credential is stale")
	ErrSessionUnknown = errors.New("session is unknown")
)

// SessionRef identifies one repository-bound live session. The durable session
// identity contract belongs to the Git-backed scope registry; this value object
// is the live lease authority's key and deliberately carries no Git fact.
type SessionRef struct {
	RepositoryID RepositoryID `json:"repositoryId"`
	SessionID    string       `json:"sessionId"`
}

func NewSessionRef(repository RepositoryRef, sessionID string) (SessionRef, error) {
	if err := repository.Validate(); err != nil {
		return SessionRef{}, err
	}
	if err := identity.Validate(sessionID); err != nil {
		return SessionRef{}, fmt.Errorf("session id: %w", err)
	}
	return SessionRef{RepositoryID: repository.ID, SessionID: sessionID}, nil
}

func (ref SessionRef) Validate() error {
	if err := ref.RepositoryID.Validate(); err != nil {
		return err
	}
	if err := identity.Validate(ref.SessionID); err != nil {
		return fmt.Errorf("session id: %w", err)
	}
	return nil
}

// SessionRegisterRequest opens a live session. TTL is the heartbeat window:
// a session with no successful heartbeat is expired and cannot be resurrected.
type SessionRegisterRequest struct {
	Ref   SessionRef
	Owner string
	TTL   time.Duration
}

func (request SessionRegisterRequest) Validate() error {
	if err := request.Ref.Validate(); err != nil {
		return err
	}
	if err := identity.Validate(request.Owner); err != nil {
		return fmt.Errorf("session owner: %w", err)
	}
	if request.TTL <= 0 {
		return errors.New("session TTL must be positive")
	}
	return nil
}

// SessionCredential is the fencing credential for heartbeat and close. It is
// invalidated by a restart (epoch) or a newer registration (fencing token).
type SessionCredential struct {
	SessionID        string `json:"sessionId"`
	Owner            string `json:"owner"`
	FencingToken     uint64 `json:"fencingToken"`
	CoordinatorEpoch uint64 `json:"coordinatorEpoch"`
}

func (credential SessionCredential) Validate() error {
	if credential.SessionID == "" || credential.Owner == "" || credential.FencingToken == 0 || credential.CoordinatorEpoch == 0 {
		return errors.New("session credential is incomplete")
	}
	return nil
}

type SessionHeartbeat struct {
	Credential SessionCredential
	TTL        time.Duration
}

func (heartbeat SessionHeartbeat) Validate() error {
	if err := heartbeat.Credential.Validate(); err != nil {
		return err
	}
	if heartbeat.TTL <= 0 {
		return errors.New("session TTL must be positive")
	}
	return nil
}

// Session is the live, expiring session view. It is never reconstructed from
// Git and its loss is explicit: clients must register again after an epoch
// change.
type Session struct {
	Ref              SessionRef `json:"ref"`
	Owner            string     `json:"owner"`
	FencingToken     uint64     `json:"fencingToken"`
	CoordinatorEpoch uint64     `json:"coordinatorEpoch"`
	StartedAt        time.Time  `json:"startedAt"`
	LastHeartbeat    time.Time  `json:"lastHeartbeat"`
	ExpiresAt        time.Time  `json:"expiresAt"`
}

func (session Session) Credential() SessionCredential {
	return SessionCredential{
		SessionID:        session.Ref.SessionID,
		Owner:            session.Owner,
		FencingToken:     session.FencingToken,
		CoordinatorEpoch: session.CoordinatorEpoch,
	}
}
