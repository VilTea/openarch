package port

import (
	"context"

	collaborationdomain "github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/evidence/domain"
)

type AuthorityRepo interface {
	AppendEvidence(ctx context.Context, evidence domain.ValidationEvidence) error
	ListEvidence(ctx context.Context) ([]domain.ValidationEvidence, error)
	Descriptor(context.Context) (collaborationdomain.DurableRepositoryDescriptor, error)
	RefreshFromRemote(context.Context, string, string) (collaborationdomain.DurableRepositoryDescriptor, error)
}

type ProjectionStore interface {
	ReplaceEvidence(ctx context.Context, evidence []domain.ValidationEvidence) error
	CalibrationByKey(ctx context.Context, key domain.CalibrationKey) (domain.Calibration, error)
}
