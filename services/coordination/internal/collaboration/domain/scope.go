package domain

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/openarch/openarch/services/coordination/internal/identity"
)

// RepositoryID identifies a Git repository. It is explicit and opaque; a
// directory name or remote URL is not a substitute for this value.
type RepositoryID string

func NewRepositoryID(value string) (RepositoryID, error) {
	if err := identity.Validate(value); err != nil {
		return "", fmt.Errorf("repositoryId: %w", err)
	}
	return RepositoryID(value), nil
}

func (id RepositoryID) Validate() error {
	if err := identity.Validate(string(id)); err != nil {
		return fmt.Errorf("repositoryId: %w", err)
	}
	return nil
}

// ServiceID identifies a capability boundary within a repository. The same
// serviceId may appear in different repositories; the pair is the identity.
type ServiceID string

func NewServiceID(value string) (ServiceID, error) {
	if err := identity.Validate(value); err != nil {
		return "", fmt.Errorf("serviceId: %w", err)
	}
	return ServiceID(value), nil
}

func (id ServiceID) Validate() error {
	if err := identity.Validate(string(id)); err != nil {
		return fmt.Errorf("serviceId: %w", err)
	}
	return nil
}

type ProductID string

func NewProductID(value string) (ProductID, error) {
	if err := identity.Validate(value); err != nil {
		return "", fmt.Errorf("productId: %w", err)
	}
	return ProductID(value), nil
}

func (id ProductID) Validate() error {
	if err := identity.Validate(string(id)); err != nil {
		return fmt.Errorf("productId: %w", err)
	}
	return nil
}

type RepositoryRef struct {
	ID RepositoryID `json:"repositoryId"`
}

func NewRepositoryRef(id string) (RepositoryRef, error) {
	repositoryID, err := NewRepositoryID(id)
	if err != nil {
		return RepositoryRef{}, err
	}
	return RepositoryRef{ID: repositoryID}, nil
}

func (ref RepositoryRef) Validate() error {
	return ref.ID.Validate()
}

// RepositorySyncNotice is the only durable-repository write acknowledgement
// sent to coordination after an agent has committed and pushed locally. The
// service treats the advertised head as a precondition for a read/refresh; it
// never accepts the notice as a substitute for Git evidence.
type RepositorySyncNotice struct {
	RepositoryID RepositoryID `json:"repositoryId"`
	Branch       string       `json:"branch"`
	HeadSHA      string       `json:"headSha"`
}

func (notice RepositorySyncNotice) Validate() error {
	if err := notice.RepositoryID.Validate(); err != nil {
		return err
	}
	branch := strings.TrimSpace(notice.Branch)
	if branch == "" || strings.ContainsAny(branch, "\x00\r\n") || strings.HasPrefix(branch, "-") || strings.Contains(branch, "..") {
		return errors.New("repository sync branch must be a safe non-empty name")
	}
	sha := strings.TrimSpace(notice.HeadSHA)
	if len(sha) != 40 {
		return errors.New("repository sync headSha must be a 40-character Git SHA-1")
	}
	if _, err := hex.DecodeString(sha); err != nil {
		return errors.New("repository sync headSha must be hexadecimal")
	}
	return nil
}

// DurableRepositoryDescriptor is read-only metadata that lets an agent
// configure its local OpenArch docs-repo. Local paths and credentials are
// intentionally absent; the service exposes only the configured remote,
// branch and currently observed head.
type DurableRepositoryDescriptor struct {
	RemoteURL string `json:"remoteUrl"`
	Branch    string `json:"branch"`
	HeadSHA   string `json:"headSha"`
}

func (descriptor DurableRepositoryDescriptor) Validate() error {
	if strings.TrimSpace(descriptor.RemoteURL) == "" || strings.TrimSpace(descriptor.Branch) == "" || strings.TrimSpace(descriptor.HeadSHA) == "" {
		return errors.New("durable repository descriptor is incomplete")
	}
	return nil
}

// ServiceRef always carries its parent repository. This prevents a service
// from becoming an unscoped global lock/task target.
type ServiceRef struct {
	RepositoryID RepositoryID `json:"repositoryId"`
	ID           ServiceID    `json:"serviceId"`
}

func NewServiceRef(repository RepositoryRef, serviceID string) (ServiceRef, error) {
	if err := repository.Validate(); err != nil {
		return ServiceRef{}, err
	}
	id, err := NewServiceID(serviceID)
	if err != nil {
		return ServiceRef{}, err
	}
	return ServiceRef{RepositoryID: repository.ID, ID: id}, nil
}

func (ref ServiceRef) Validate() error {
	if err := ref.RepositoryID.Validate(); err != nil {
		return err
	}
	return ref.ID.Validate()
}

type ProductRef struct {
	ID       ProductID    `json:"productId"`
	Services []ServiceRef `json:"services"`
}

func NewProductRef(productID string, services []ServiceRef) (ProductRef, error) {
	id, err := NewProductID(productID)
	if err != nil {
		return ProductRef{}, err
	}
	product := ProductRef{ID: id, Services: append([]ServiceRef(nil), services...)}
	if err := product.Validate(); err != nil {
		return ProductRef{}, err
	}
	return product, nil
}

func (ref ProductRef) Validate() error {
	if err := ref.ID.Validate(); err != nil {
		return err
	}
	if len(ref.Services) == 0 {
		return errors.New("product must reference at least one service")
	}
	seen := make(map[string]struct{}, len(ref.Services))
	for _, service := range ref.Services {
		if err := service.Validate(); err != nil {
			return err
		}
		key := string(service.RepositoryID) + "\x00" + string(service.ID)
		if _, exists := seen[key]; exists {
			return fmt.Errorf("product references service more than once: %s/%s", service.RepositoryID, service.ID)
		}
		seen[key] = struct{}{}
	}
	return nil
}

// LegacyProjectRef names the old docs-repo location. It is accepted only as
// migration input; its basename can never become a RepositoryID implicitly.
type LegacyProjectRef struct {
	Path string `json:"path"`
}

func (ref LegacyProjectRef) Validate() error {
	canonical := strings.ReplaceAll(strings.TrimSpace(ref.Path), "\\", "/")
	if canonical == "" || !strings.HasPrefix(canonical, "projects/") {
		return errors.New("legacy project path must be a relative projects/<basename> location")
	}
	basename := strings.TrimPrefix(canonical, "projects/")
	if basename == "" || strings.Contains(basename, "/") || basename == "." || basename == ".." {
		return errors.New("legacy project path must contain exactly one non-empty basename")
	}
	return nil
}

// MigrateLegacyProject requires the caller to provide a new stable identity.
// The legacy basename is intentionally discarded rather than promoted.
func MigrateLegacyProject(legacy LegacyProjectRef, repositoryID string) (RepositoryRef, error) {
	if err := legacy.Validate(); err != nil {
		return RepositoryRef{}, err
	}
	return NewRepositoryRef(repositoryID)
}
