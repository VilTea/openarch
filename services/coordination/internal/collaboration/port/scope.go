package port

import (
	"context"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

// ScopeStore persists durable scope registrations. It deliberately does not
// expose lease operations; active locks belong to LeaseStore.
type ScopeStore interface {
	Read(context.Context) (domain.ScopeRegistry, error)
	ListLegacyProjects(context.Context) ([]domain.LegacyProjectRef, error)
}
