package domain

import (
	"errors"
	"fmt"
)

const ScopeSchemaVersion = "1"

type RepositoryDocument struct {
	SchemaVersion string        `json:"schemaVersion"`
	Repository    RepositoryRef `json:"repository"`
}

type ServiceDocument struct {
	SchemaVersion string     `json:"schemaVersion"`
	Service       ServiceRef `json:"service"`
}

type ProductDocument struct {
	SchemaVersion string     `json:"schemaVersion"`
	Product       ProductRef `json:"product"`
}

type ScopeRegistry struct {
	Repositories []RepositoryDocument `json:"repositories"`
	Services     []ServiceDocument    `json:"services"`
	Products     []ProductDocument    `json:"products"`
}

func (document RepositoryDocument) Validate() error {
	if document.SchemaVersion != ScopeSchemaVersion {
		return fmt.Errorf("repository scope schema must be %q", ScopeSchemaVersion)
	}
	return document.Repository.Validate()
}

func (document ServiceDocument) Validate() error {
	if document.SchemaVersion != ScopeSchemaVersion {
		return fmt.Errorf("service scope schema must be %q", ScopeSchemaVersion)
	}
	return document.Service.Validate()
}

func (document ProductDocument) Validate() error {
	if document.SchemaVersion != ScopeSchemaVersion {
		return fmt.Errorf("product scope schema must be %q", ScopeSchemaVersion)
	}
	return document.Product.Validate()
}

func (registry ScopeRegistry) Validate() error {
	repositories := make(map[RepositoryID]struct{}, len(registry.Repositories))
	for _, document := range registry.Repositories {
		if err := document.Validate(); err != nil {
			return err
		}
		if _, exists := repositories[document.Repository.ID]; exists {
			return fmt.Errorf("repository scope is registered more than once: %s", document.Repository.ID)
		}
		repositories[document.Repository.ID] = struct{}{}
	}
	services := make(map[string]struct{}, len(registry.Services))
	for _, document := range registry.Services {
		if err := document.Validate(); err != nil {
			return err
		}
		if _, exists := repositories[document.Service.RepositoryID]; !exists {
			return fmt.Errorf("service references an unregistered repository: %s", document.Service.RepositoryID)
		}
		key := serviceKey(document.Service)
		if _, exists := services[key]; exists {
			return fmt.Errorf("service scope is registered more than once: %s", key)
		}
		services[key] = struct{}{}
	}
	for _, document := range registry.Products {
		if err := document.Validate(); err != nil {
			return err
		}
		for _, service := range document.Product.Services {
			if _, exists := services[serviceKey(service)]; !exists {
				return fmt.Errorf("product references an unregistered service: %s/%s", service.RepositoryID, service.ID)
			}
		}
	}
	return nil
}

func (registry ScopeRegistry) WithRepository(document RepositoryDocument) (ScopeRegistry, error) {
	if err := document.Validate(); err != nil {
		return ScopeRegistry{}, err
	}
	next := cloneRegistry(registry)
	replaced := false
	for index, current := range next.Repositories {
		if current.Repository.ID == document.Repository.ID {
			next.Repositories[index] = document
			replaced = true
			break
		}
	}
	if !replaced {
		next.Repositories = append(next.Repositories, document)
	}
	return next, next.Validate()
}

func (registry ScopeRegistry) WithService(document ServiceDocument) (ScopeRegistry, error) {
	if err := document.Validate(); err != nil {
		return ScopeRegistry{}, err
	}
	next := cloneRegistry(registry)
	key := serviceKey(document.Service)
	replaced := false
	for index, current := range next.Services {
		if serviceKey(current.Service) == key {
			next.Services[index] = document
			replaced = true
			break
		}
	}
	if !replaced {
		next.Services = append(next.Services, document)
	}
	return next, next.Validate()
}

func (registry ScopeRegistry) WithProduct(document ProductDocument) (ScopeRegistry, error) {
	if err := document.Validate(); err != nil {
		return ScopeRegistry{}, err
	}
	next := cloneRegistry(registry)
	replaced := false
	for index, current := range next.Products {
		if current.Product.ID == document.Product.ID {
			next.Products[index] = document
			replaced = true
			break
		}
	}
	if !replaced {
		next.Products = append(next.Products, document)
	}
	return next, next.Validate()
}

func serviceKey(service ServiceRef) string {
	return string(service.RepositoryID) + "\x00" + string(service.ID)
}

func cloneRegistry(registry ScopeRegistry) ScopeRegistry {
	return ScopeRegistry{
		Repositories: append([]RepositoryDocument(nil), registry.Repositories...),
		Services:     append([]ServiceDocument(nil), registry.Services...),
		Products:     append([]ProductDocument(nil), registry.Products...),
	}
}

var ErrScopeDocumentMissing = errors.New("scope document is missing")
