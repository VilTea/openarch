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
}
