package application

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/port"
)

// DebtService projects Agent-owned versioned Debt documents. It performs no
// lifecycle transitions: resolved/superseded are durable document edits.
type DebtService struct {
	debts port.DebtStore
}

func NewDebtService(debts port.DebtStore) (DebtService, error) {
	if debts == nil {
		return DebtService{}, fmt.Errorf("debt service requires a debt store")
	}
	return DebtService{debts: debts}, nil
}

func (s DebtService) List(ctx context.Context, repositoryID string) ([]domain.DebtDocument, error) {
	filter := strings.TrimSpace(repositoryID)
	if filter != "" {
		if err := domain.RepositoryID(filter).Validate(); err != nil {
			return nil, fmt.Errorf("debt list repositoryId: %w", err)
		}
	}
	documents, err := s.debts.List(ctx)
	if err != nil {
		return nil, err
	}
	if filter == "" {
		return documents, nil
	}
	filtered := make([]domain.DebtDocument, 0, len(documents))
	for _, document := range documents {
		if string(document.Debt.RepositoryID) == filter {
			filtered = append(filtered, document)
		}
	}
	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].Debt.DebtID < filtered[j].Debt.DebtID
	})
	return filtered, nil
}
