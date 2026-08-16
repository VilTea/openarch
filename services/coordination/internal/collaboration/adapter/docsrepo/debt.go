package docsrepo

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/port"
	docsrepo "github.com/openarch/openarch/services/coordination/internal/evidence/adapter/docsrepo"
)

var _ port.DebtStore = (*DebtStore)(nil)

// DebtStore keeps Debt documents Agent-owned: it only reads the shared Git
// snapshot and cannot publish or rewrite a Debt.
type DebtStore struct {
	repository *docsrepo.Repository
}

func NewDebtStore(repository *docsrepo.Repository) (*DebtStore, error) {
	if repository == nil {
		return nil, fmt.Errorf("debt store requires a docs-repo read boundary")
	}
	return &DebtStore{repository: repository}, nil
}

func (s *DebtStore) Read(ctx context.Context, ref domain.DebtRef) (domain.DebtDocument, bool, error) {
	if err := ref.Validate(); err != nil {
		return domain.DebtDocument{}, false, err
	}
	path := domain.DebtPath(ref)
	payload, exists, err := s.repository.ReadFileAtHead(ctx, path)
	if err != nil || !exists {
		return domain.DebtDocument{}, exists, err
	}
	document, err := decodeDebtDocument(payload, path, ref)
	if err != nil {
		return domain.DebtDocument{}, false, err
	}
	return document, true, nil
}

func decodeDebtDocument(payload []byte, path string, ref domain.DebtRef) (domain.DebtDocument, error) {
	var document domain.DebtDocument
	if err := decodeStrictJSON(payload, &document); err != nil {
		return domain.DebtDocument{}, fmt.Errorf("decode debt document %q: %w", path, err)
	}
	if err := document.Validate(); err != nil {
		return domain.DebtDocument{}, err
	}
	if document.Debt != ref {
		return domain.DebtDocument{}, fmt.Errorf("debt path %q disagrees with debt identity", path)
	}
	return document, nil
}

func (s *DebtStore) List(ctx context.Context) ([]domain.DebtDocument, error) {
	snapshots, err := s.repository.ReadListedFilesAtHead(ctx, "debts")
	if err != nil {
		return nil, err
	}
	documents := make([]domain.DebtDocument, 0, len(snapshots))
	for _, snapshot := range snapshots {
		ref, ok, err := debtRefFromPath(snapshot.Path)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if domain.DebtPath(ref) != snapshot.Path {
			return nil, fmt.Errorf("debt path %q disagrees with debt identity", snapshot.Path)
		}
		document, err := decodeDebtDocument(snapshot.Content, snapshot.Path, ref)
		if err != nil {
			return nil, err
		}
		documents = append(documents, document)
	}
	sort.Slice(documents, func(i, j int) bool {
		return debtRefKey(documents[i].Debt) < debtRefKey(documents[j].Debt)
	})
	return documents, nil
}

func debtRefFromPath(path string) (domain.DebtRef, bool, error) {
	parts := strings.Split(filepath.ToSlash(path), "/")
	if len(parts) != 4 || parts[0] != "debts" || !strings.HasSuffix(parts[3], ".json") {
		return domain.DebtRef{}, false, nil
	}
	ref := domain.DebtRef{
		RepositoryID: domain.RepositoryID(parts[1]),
		ServiceID:    domain.ServiceID(parts[2]),
		DebtID:       strings.TrimSuffix(parts[3], ".json"),
	}
	if err := ref.Validate(); err != nil {
		return domain.DebtRef{}, false, fmt.Errorf("invalid debt path %q: %w", path, err)
	}
	return ref, true, nil
}

func debtRefKey(ref domain.DebtRef) string {
	return string(ref.RepositoryID) + "\x00" + string(ref.ServiceID) + "\x00" + ref.DebtID
}
