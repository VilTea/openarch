package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/identity"
)

var (
	ErrLeaseHeld    = errors.New("semantic lease is held")
	ErrLeaseExpired = errors.New("semantic lease is expired")
	ErrLeaseStale   = errors.New("semantic lease credential is stale")
)

// LeaseKey identifies one repository-scoped semantic target. Target is a
// parser-produced canonical identity; it is not inferred from a file path.
type LeaseKey struct {
	RepositoryID RepositoryID `json:"repositoryId"`
	Target       string       `json:"target"`
}

func NewLeaseKey(repository RepositoryRef, target string) (LeaseKey, error) {
	if err := repository.Validate(); err != nil {
		return LeaseKey{}, err
	}
	if err := validateTarget(target); err != nil {
		return LeaseKey{}, err
	}
	return LeaseKey{RepositoryID: repository.ID, Target: target}, nil
}

func (key LeaseKey) Validate() error {
	if err := key.RepositoryID.Validate(); err != nil {
		return err
	}
	return validateTarget(key.Target)
}

func validateTarget(target string) error {
	if target == "" || len(target) > 512 || strings.TrimSpace(target) != target || strings.ContainsAny(target, "\x00\r\n") {
		return errors.New("semantic lease target must be a bounded canonical identity")
	}
	return nil
}

type LeaseRequest struct {
	Key   LeaseKey
	Owner string
	TTL   time.Duration
}

func (request LeaseRequest) Validate() error {
	if err := request.Key.Validate(); err != nil {
		return err
	}
	if err := identity.Validate(request.Owner); err != nil {
		return fmt.Errorf("lease owner: %w", err)
	}
	if request.TTL <= 0 {
		return errors.New("lease TTL must be positive")
	}
	return nil
}

type LeaseCredential struct {
	LeaseID          string `json:"leaseId"`
	Owner            string `json:"owner"`
	FencingToken     uint64 `json:"fencingToken"`
	CoordinatorEpoch uint64 `json:"coordinatorEpoch"`
}

func (credential LeaseCredential) Validate() error {
	if credential.LeaseID == "" || credential.Owner == "" || credential.FencingToken == 0 || credential.CoordinatorEpoch == 0 {
		return errors.New("lease credential is incomplete")
	}
	return nil
}

type LeaseRenewal struct {
	Credential LeaseCredential
	TTL        time.Duration
}

type Lease struct {
	Key              LeaseKey  `json:"key"`
	LeaseID          string    `json:"leaseId"`
	Owner            string    `json:"owner"`
	FencingToken     uint64    `json:"fencingToken"`
	CoordinatorEpoch uint64    `json:"coordinatorEpoch"`
	ExpiresAt        time.Time `json:"expiresAt"`
}

func (lease Lease) Credential() LeaseCredential {
	return LeaseCredential{
		LeaseID: lease.LeaseID, Owner: lease.Owner,
		FencingToken: lease.FencingToken, CoordinatorEpoch: lease.CoordinatorEpoch,
	}
}

func (renewal LeaseRenewal) Validate() error {
	if err := renewal.Credential.Validate(); err != nil {
		return err
	}
	if renewal.TTL <= 0 {
		return errors.New("lease TTL must be positive")
	}
	return nil
}
