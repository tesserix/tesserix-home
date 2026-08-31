package secrets

import (
	"context"
	"fmt"
	"sort"
)

// Backend names one secret store the console can drive.
type Backend string

const (
	BackendOpenBao Backend = "openbao"
	BackendGCPSM   Backend = "gcpsm"
)

// Store is everything the console may do to a secret. Read is absent by
// design: no backend implementation exposes a value, so no handler can leak
// one.
type Store interface {
	List(ctx context.Context, prefix string) ([]Entry, error)
	Describe(ctx context.Context, path string) (Secret, error)
	// ifVersion is the version the caller expects to be current; a positive
	// value that no longer matches fails the write with ErrConflict rather than
	// overwriting whatever landed in the meantime.
	Write(ctx context.Context, path string, data map[string]string, ifVersion int) (int, error)
	Delete(ctx context.Context, path string) error
	Destroy(ctx context.Context, path string) error
	Restore(ctx context.Context, path string, version int) error
	Versions(ctx context.Context, path string) ([]Version, error)
	// Health answers whether the store is reachable and usable, so a sealed or
	// denied backend is reported once rather than as a failure per request.
	Health(ctx context.Context) error
}

// Registry is the set of backends this deployment enabled. A backend absent
// from it cannot be addressed by a request, so enabling one is a deployment
// decision rather than a caller's.
type Registry struct {
	stores   map[Backend]Store
	fallback Backend
	order    []Backend
}

func NewRegistry(fallback Backend, stores map[Backend]Store) (*Registry, error) {
	if len(stores) == 0 {
		return nil, fmt.Errorf("secrets: at least one backend must be enabled")
	}
	if _, ok := stores[fallback]; !ok {
		return nil, fmt.Errorf("secrets: default backend %q is not enabled", fallback)
	}

	order := make([]Backend, 0, len(stores))
	for name := range stores {
		order = append(order, name)
	}
	sort.Slice(order, func(i, j int) bool {
		if order[i] == fallback || order[j] == fallback {
			return order[i] == fallback
		}
		return order[i] < order[j]
	})

	return &Registry{stores: stores, fallback: fallback, order: order}, nil
}

// Resolve maps a request's backend name to its store; an empty name is the
// deployment's default.
func (r *Registry) Resolve(name string) (Store, Backend, error) {
	backend := Backend(name)
	if name == "" {
		backend = r.fallback
	}
	store, ok := r.stores[backend]
	if !ok {
		return nil, "", fmt.Errorf("%w: %q", ErrUnknownBackend, name)
	}
	return store, backend, nil
}

// Backends lists the enabled backends, default first.
func (r *Registry) Backends() []Backend { return append([]Backend(nil), r.order...) }

func (r *Registry) Default() Backend { return r.fallback }
