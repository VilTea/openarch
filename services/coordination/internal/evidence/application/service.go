package application

import (
	"context"
	"strings"

	collaborationdomain "github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	collaborationport "github.com/openarch/openarch/services/coordination/internal/collaboration/port"
	"github.com/openarch/openarch/services/coordination/internal/evidence/domain"
	"github.com/openarch/openarch/services/coordination/internal/evidence/port"
)

type Service struct {
	authorityRepo  port.AuthorityRepo
	projectionRead port.ProjectionStore
	scopeStore     collaborationport.ScopeStore
}

func NewService(authorityRepo port.AuthorityRepo, projectionRead port.ProjectionStore, scopeStore collaborationport.ScopeStore) Service {
	return Service{
		authorityRepo:  authorityRepo,
		projectionRead: projectionRead,
		scopeStore:     scopeStore,
	}
}

// IngestEvidence is intentionally service-owned evidence. It is not a
// generic document write: the authority adapter owns only the designated
// calibration record and commits it with the coordination identity.
func (s Service) IngestEvidence(ctx context.Context, evidence domain.ValidationEvidence) error {
	if err := evidence.Validate(); err != nil {
		return err
	}
	if err := s.authorityRepo.AppendEvidence(ctx, evidence); err != nil {
		return err
	}
	return s.refreshProjection(ctx)
}

func (s Service) GetCalibration(ctx context.Context, key domain.CalibrationKey) (domain.Calibration, error) {
	if err := key.Validate(); err != nil {
		return domain.Calibration{}, err
	}
	// 只读接口直接读投影；投影缺失/损坏时才重建（ingest/refresh 已在写路径重建）。
	calibration, err := s.projectionRead.CalibrationByKey(ctx, key)
	if err == nil {
		return calibration, nil
	}
	if err := s.refreshProjection(ctx); err != nil {
		return domain.Calibration{}, err
	}
	return s.projectionRead.CalibrationByKey(ctx, key)
}

type RepositoryInfo struct {
	DocsRepo       collaborationdomain.DurableRepositoryDescriptor `json:"docsRepo"`
	Scope          collaborationdomain.ScopeRegistry               `json:"scope,omitempty"`
	ScopeState     string                                          `json:"scopeState"`
	LegacyProjects []collaborationdomain.LegacyProjectRef          `json:"legacyProjects,omitempty"`
}

// GetRepositoryInfo is a read-only bootstrap endpoint for agents. It returns
// the redacted remote address and current head, the registered scope, and any
// legacy `projects/<basename>` locations that still need an explicit
// migration to the repository/service/product registry.
func (s Service) GetRepositoryInfo(ctx context.Context) (RepositoryInfo, error) {
	descriptor, err := s.authorityRepo.Descriptor(ctx)
	if err != nil {
		return RepositoryInfo{}, err
	}
	info := RepositoryInfo{DocsRepo: descriptor, ScopeState: "unavailable"}
	if s.scopeStore == nil {
		return info, nil
	}
	registry, err := s.scopeStore.Read(ctx)
	if err != nil {
		return RepositoryInfo{}, err
	}
	info.Scope = registry
	info.ScopeState = "available"
	legacy, err := s.scopeStore.ListLegacyProjects(ctx)
	if err != nil {
		return RepositoryInfo{}, err
	}
	info.LegacyProjects = legacy
	return info, nil
}

// RefreshRepository acknowledges an agent-pushed head. The service performs
// the bounded Git operation (fetch and fast-forward of its disposable
// worktree), then rebuilds projections from the resulting Git facts. When
// another project advanced the shared branch after this agent's push, an
// advertised ancestor head is still accepted; the returned info carries the
// actual head the projection was rebuilt from.
func (s Service) RefreshRepository(ctx context.Context, notice collaborationdomain.RepositorySyncNotice) (RepositoryInfo, error) {
	if err := notice.Validate(); err != nil {
		return RepositoryInfo{}, err
	}
	if _, err := s.authorityRepo.RefreshFromRemote(ctx, strings.TrimSpace(notice.Branch), strings.ToLower(strings.TrimSpace(notice.HeadSHA))); err != nil {
		return RepositoryInfo{}, err
	}
	if err := s.refreshProjection(ctx); err != nil {
		return RepositoryInfo{}, err
	}
	return s.GetRepositoryInfo(ctx)
}

func (s Service) refreshProjection(ctx context.Context) error {
	records, err := s.authorityRepo.ListEvidence(ctx)
	if err != nil {
		return err
	}
	return s.projectionRead.ReplaceEvidence(ctx, records)
}
