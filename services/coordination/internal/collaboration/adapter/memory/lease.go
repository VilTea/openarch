package memory

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/openarch/openarch/services/coordination/internal/collaboration/domain"
	"github.com/openarch/openarch/services/coordination/internal/collaboration/port"
)

var _ port.LeaseStore = (*Store)(nil)

type Clock func() time.Time

type Store struct {
	mu          sync.Mutex
	clock       Clock
	minTTL      time.Duration
	maxTTL      time.Duration
	epoch       uint64
	nextLeaseID uint64
	nextFence   uint64
	leases      map[domain.LeaseKey]domain.Lease
}

func New(epoch uint64, minTTL time.Duration, maxTTL time.Duration, clock Clock) (*Store, error) {
	if epoch == 0 || minTTL <= 0 || maxTTL < minTTL || clock == nil {
		return nil, fmt.Errorf("invalid lease store configuration")
	}
	return &Store{
		clock: clock, minTTL: minTTL, maxTTL: maxTTL, epoch: epoch,
		leases: make(map[domain.LeaseKey]domain.Lease),
	}, nil
}

func (s *Store) Acquire(ctx context.Context, request domain.LeaseRequest) (domain.Lease, error) {
	if err := contextError(ctx); err != nil {
		return domain.Lease{}, err
	}
	request.Key.Target = domain.NormalizeTarget(request.Key.Target)
	if err := request.Validate(); err != nil {
		return domain.Lease{}, err
	}
	if err := s.validateTTL(request.TTL); err != nil {
		return domain.Lease{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	s.removeExpired(now)
	if _, exists := s.leases[request.Key]; exists {
		return domain.Lease{}, domain.ErrLeaseHeld
	}
	s.nextLeaseID++
	s.nextFence++
	lease := domain.Lease{
		Key: request.Key, LeaseID: fmt.Sprintf("%d:%d", s.epoch, s.nextLeaseID), Owner: request.Owner,
		FencingToken: s.nextFence, CoordinatorEpoch: s.epoch, ExpiresAt: now.Add(request.TTL),
	}
	s.leases[request.Key] = lease
	return lease, nil
}

func (s *Store) Renew(ctx context.Context, renewal domain.LeaseRenewal) (domain.Lease, error) {
	if err := contextError(ctx); err != nil {
		return domain.Lease{}, err
	}
	if err := renewal.Validate(); err != nil {
		return domain.Lease{}, err
	}
	if err := s.validateTTL(renewal.TTL); err != nil {
		return domain.Lease{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	lease, ok := s.findByID(renewal.Credential.LeaseID)
	if !ok {
		return domain.Lease{}, domain.ErrLeaseExpired
	}
	if !now.Before(lease.ExpiresAt) {
		delete(s.leases, lease.Key)
		return domain.Lease{}, domain.ErrLeaseExpired
	}
	if lease.Credential() != renewal.Credential {
		return domain.Lease{}, domain.ErrLeaseStale
	}
	lease.ExpiresAt = now.Add(renewal.TTL)
	s.leases[lease.Key] = lease
	return lease, nil
}

func (s *Store) Release(ctx context.Context, credential domain.LeaseCredential) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	if err := credential.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	lease, ok := s.findByID(credential.LeaseID)
	if !ok {
		return nil
	}
	if lease.Credential() != credential {
		return domain.ErrLeaseStale
	}
	delete(s.leases, lease.Key)
	return nil
}

func (s *Store) Get(ctx context.Context, key domain.LeaseKey) (domain.Lease, bool, error) {
	if err := contextError(ctx); err != nil {
		return domain.Lease{}, false, err
	}
	key.Target = domain.NormalizeTarget(key.Target)
	if err := key.Validate(); err != nil {
		return domain.Lease{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	s.removeExpired(now)
	lease, ok := s.leases[key]
	return lease, ok, nil
}

func (s *Store) List(ctx context.Context) ([]domain.Lease, error) {
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeExpired(s.clock())
	leases := make([]domain.Lease, 0, len(s.leases))
	for _, lease := range s.leases {
		leases = append(leases, lease)
	}
	sort.Slice(leases, func(i, j int) bool {
		if leases[i].Key.RepositoryID != leases[j].Key.RepositoryID {
			return leases[i].Key.RepositoryID < leases[j].Key.RepositoryID
		}
		return leases[i].Key.Target < leases[j].Key.Target
	})
	return leases, nil
}

func (s *Store) validateTTL(ttl time.Duration) error {
	if ttl < s.minTTL || ttl > s.maxTTL {
		return fmt.Errorf("lease TTL must be between %s and %s", s.minTTL, s.maxTTL)
	}
	return nil
}

func (s *Store) findByID(id string) (domain.Lease, bool) {
	for _, lease := range s.leases {
		if lease.LeaseID == id {
			return lease, true
		}
	}
	return domain.Lease{}, false
}

func (s *Store) removeExpired(now time.Time) {
	for key, lease := range s.leases {
		if !now.Before(lease.ExpiresAt) {
			delete(s.leases, key)
		}
	}
}

func contextError(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	return ctx.Err()
}
