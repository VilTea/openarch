package port

import (
	"context"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

// LeaseStore is the live authority for expiring coordination leases. It is
// intentionally independent from the Git-backed durable authority port.
type LeaseStore interface {
	Acquire(context.Context, domain.LeaseRequest) (domain.Lease, error)
	Renew(context.Context, domain.LeaseRenewal) (domain.Lease, error)
	Release(context.Context, domain.LeaseCredential) error
	Get(context.Context, domain.LeaseKey) (domain.Lease, bool, error)
	// List returns currently held (unexpired) leases. It is a live,
	// expiring read model, never a durable fact source.
	List(context.Context) ([]domain.Lease, error)
}

// LeaseVerifier is the narrow read-only view TaskService needs to enforce
// that completion stages happen while the completing agent still holds the
// semantic lock for the declared target.
type LeaseVerifier interface {
	Get(context.Context, domain.LeaseKey) (domain.Lease, bool, error)
}
