package port

import (
	"context"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

// LiveSessionStore is the live authority for expiring repository-bound
// sessions. Like LeaseStore it is intentionally independent from Git: durable
// session identity must come from the scope registry, while this port only
// owns liveness, heartbeat expiry, and fencing.
type LiveSessionStore interface {
	Register(context.Context, domain.SessionRegisterRequest) (domain.Session, error)
	Heartbeat(context.Context, domain.SessionHeartbeat) (domain.Session, error)
	Close(context.Context, domain.SessionCredential) error
	Get(context.Context, domain.SessionRef) (domain.Session, bool, error)
	List(context.Context) ([]domain.Session, error)
}
