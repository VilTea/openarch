package port

import (
	"context"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
)

// DebtStore reads Agent-owned versioned Debt documents. Debt has no service
// lifecycle state; resolved/superseded transitions are durable document edits.
type DebtStore interface {
	Read(context.Context, domain.DebtRef) (domain.DebtDocument, bool, error)
	List(context.Context) ([]domain.DebtDocument, error)
}
