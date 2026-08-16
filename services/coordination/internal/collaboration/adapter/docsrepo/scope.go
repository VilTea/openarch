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

const scopeDocumentName = "scope.json"

var _ port.ScopeStore = (*Store)(nil)

type Store struct {
	repository *docsrepo.Repository
}

func New(repository *docsrepo.Repository) (*Store, error) {
	if repository == nil {
		return nil, fmt.Errorf("scope store requires a docs-repo authority")
	}
	return &Store{repository: repository}, nil
}

func (s *Store) Read(ctx context.Context) (domain.ScopeRegistry, error) {
	registry := domain.ScopeRegistry{}
	repositories, err := s.repository.ReadListedFilesAtHead(ctx, "repositories")
	if err != nil {
		return registry, err
	}
	for _, snapshot := range repositories {
		if !isScopeDocument(snapshot.Path, "repositories", 3) {
			continue
		}
		var document domain.RepositoryDocument
		if err := decodeScopePayload(snapshot.Content, snapshot.Path, &document); err != nil {
			return registry, err
		}
		if err := verifyRepositoryPath(snapshot.Path, document); err != nil {
			return registry, err
		}
		registry.Repositories = append(registry.Repositories, document)
	}
	services, err := s.repository.ReadListedFilesAtHead(ctx, "services")
	if err != nil {
		return registry, err
	}
	for _, snapshot := range services {
		if !isScopeDocument(snapshot.Path, "services", 4) {
			continue
		}
		var document domain.ServiceDocument
		if err := decodeScopePayload(snapshot.Content, snapshot.Path, &document); err != nil {
			return registry, err
		}
		if err := verifyServicePath(snapshot.Path, document); err != nil {
			return registry, err
		}
		registry.Services = append(registry.Services, document)
	}
	products, err := s.repository.ReadListedFilesAtHead(ctx, "products")
	if err != nil {
		return registry, err
	}
	for _, snapshot := range products {
		if !isScopeDocument(snapshot.Path, "products", 3) {
			continue
		}
		var document domain.ProductDocument
		if err := decodeScopePayload(snapshot.Content, snapshot.Path, &document); err != nil {
			return registry, err
		}
		if err := verifyProductPath(snapshot.Path, document); err != nil {
			return registry, err
		}
		registry.Products = append(registry.Products, document)
	}
	sort.Slice(registry.Repositories, func(i, j int) bool {
		return registry.Repositories[i].Repository.ID < registry.Repositories[j].Repository.ID
	})
	sort.Slice(registry.Services, func(i, j int) bool {
		return serviceKey(registry.Services[i].Service) < serviceKey(registry.Services[j].Service)
	})
	sort.Slice(registry.Products, func(i, j int) bool { return registry.Products[i].Product.ID < registry.Products[j].Product.ID })
	if err := registry.Validate(); err != nil {
		return domain.ScopeRegistry{}, err
	}
	return registry, nil
}

func (s *Store) ListLegacyProjects(ctx context.Context) ([]domain.LegacyProjectRef, error) {
	paths, err := s.repository.ListFilesAtHead(ctx, "projects")
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	legacy := make([]domain.LegacyProjectRef, 0)
	for _, path := range paths {
		parts := strings.Split(filepath.ToSlash(path), "/")
		if len(parts) < 2 || parts[0] != "projects" {
			continue
		}
		candidate := domain.LegacyProjectRef{Path: "projects/" + parts[1]}
		if err := candidate.Validate(); err != nil {
			return nil, err
		}
		if _, exists := seen[candidate.Path]; exists {
			continue
		}
		seen[candidate.Path] = struct{}{}
		legacy = append(legacy, candidate)
	}
	sort.Slice(legacy, func(i, j int) bool { return legacy[i].Path < legacy[j].Path })
	return legacy, nil
}

func decodeScopePayload(payload []byte, path string, target any) error {
	if err := decodeStrictJSON(payload, target); err != nil {
		return fmt.Errorf("decode scope document %q: %w", path, err)
	}
	return nil
}

func isScopeDocument(path string, prefix string, count int) bool {
	parts := strings.Split(filepath.ToSlash(path), "/")
	return len(parts) == count && parts[0] == prefix && parts[len(parts)-1] == scopeDocumentName
}

func repositoryPath(repository domain.RepositoryRef) string {
	return filepath.ToSlash(filepath.Join("repositories", string(repository.ID), scopeDocumentName))
}

func servicePath(service domain.ServiceRef) string {
	return filepath.ToSlash(filepath.Join("services", string(service.RepositoryID), string(service.ID), scopeDocumentName))
}

func productPath(product domain.ProductRef) string {
	return filepath.ToSlash(filepath.Join("products", string(product.ID), scopeDocumentName))
}

func verifyRepositoryPath(path string, document domain.RepositoryDocument) error {
	if err := document.Validate(); err != nil {
		return err
	}
	expected := repositoryPath(document.Repository)
	if filepath.ToSlash(path) != expected {
		return fmt.Errorf("repository scope path %q disagrees with identity %q", path, document.Repository.ID)
	}
	return nil
}

func verifyServicePath(path string, document domain.ServiceDocument) error {
	if err := document.Validate(); err != nil {
		return err
	}
	expected := servicePath(document.Service)
	if filepath.ToSlash(path) != expected {
		return fmt.Errorf("service scope path %q disagrees with identity %s/%s", path, document.Service.RepositoryID, document.Service.ID)
	}
	return nil
}

func verifyProductPath(path string, document domain.ProductDocument) error {
	if err := document.Validate(); err != nil {
		return err
	}
	expected := productPath(document.Product)
	if filepath.ToSlash(path) != expected {
		return fmt.Errorf("product scope path %q disagrees with identity %q", path, document.Product.ID)
	}
	return nil
}

func serviceKey(service domain.ServiceRef) string {
	return string(service.RepositoryID) + "\x00" + string(service.ID)
}
