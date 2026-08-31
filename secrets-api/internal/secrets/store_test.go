package secrets_test

import (
	"context"
	"errors"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

type stub struct{ name string }

func (s stub) List(context.Context, string) ([]secrets.Entry, error) { return nil, nil }
func (s stub) Describe(context.Context, string) (secrets.Secret, error) {
	return secrets.Secret{Path: s.name}, nil
}
func (s stub) Write(context.Context, string, map[string]string, int) (int, error) { return 1, nil }
func (s stub) Delete(context.Context, string) error                               { return nil }
func (s stub) Destroy(context.Context, string) error                              { return nil }
func (s stub) Restore(context.Context, string, int) error                         { return nil }
func (s stub) Health(context.Context) error                                       { return nil }
func (s stub) Versions(context.Context, string) ([]secrets.Version, error)        { return nil, nil }

func TestRegistryResolvesTheDefaultForAnEmptyName(t *testing.T) {
	reg, err := secrets.NewRegistry(secrets.BackendOpenBao, map[secrets.Backend]secrets.Store{
		secrets.BackendOpenBao: stub{name: "bao"},
		secrets.BackendGCPSM:   stub{name: "gcp"},
	})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	store, backend, err := reg.Resolve("")
	if err != nil {
		t.Fatalf("Resolve(\"\") = %v", err)
	}
	if backend != secrets.BackendOpenBao {
		t.Fatalf("Resolve(\"\") backend = %q, want openbao", backend)
	}
	if got, _ := store.Describe(context.Background(), "a/b/c"); got.Path != "bao" {
		t.Fatalf("Resolve(\"\") returned the wrong store: %+v", got)
	}
}

func TestRegistryResolvesANamedBackend(t *testing.T) {
	reg, err := secrets.NewRegistry(secrets.BackendOpenBao, map[secrets.Backend]secrets.Store{
		secrets.BackendOpenBao: stub{name: "bao"},
		secrets.BackendGCPSM:   stub{name: "gcp"},
	})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	store, backend, err := reg.Resolve("gcpsm")
	if err != nil {
		t.Fatalf("Resolve(gcpsm) = %v", err)
	}
	if backend != secrets.BackendGCPSM {
		t.Fatalf("backend = %q, want gcpsm", backend)
	}
	if got, _ := store.Describe(context.Background(), "a/b/c"); got.Path != "gcp" {
		t.Fatalf("Resolve(gcpsm) returned the wrong store: %+v", got)
	}
}

func TestRegistryRejectsABackendThatIsNotEnabled(t *testing.T) {
	reg, err := secrets.NewRegistry(secrets.BackendOpenBao, map[secrets.Backend]secrets.Store{
		secrets.BackendOpenBao: stub{name: "bao"},
	})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	if _, _, err := reg.Resolve("gcpsm"); !errors.Is(err, secrets.ErrUnknownBackend) {
		t.Fatalf("Resolve(gcpsm) = %v, want ErrUnknownBackend", err)
	}
	if _, _, err := reg.Resolve("../openbao"); !errors.Is(err, secrets.ErrUnknownBackend) {
		t.Fatalf("Resolve of a junk name = %v, want ErrUnknownBackend", err)
	}
}

func TestNewRegistryRefusesADefaultItDoesNotHold(t *testing.T) {
	if _, err := secrets.NewRegistry(secrets.BackendGCPSM, map[secrets.Backend]secrets.Store{
		secrets.BackendOpenBao: stub{name: "bao"},
	}); err == nil {
		t.Fatal("NewRegistry with an absent default succeeded, want error")
	}
	if _, err := secrets.NewRegistry(secrets.BackendOpenBao, nil); err == nil {
		t.Fatal("NewRegistry with no stores succeeded, want error")
	}
}

func TestRegistryListsEnabledBackendsInAStableOrder(t *testing.T) {
	reg, err := secrets.NewRegistry(secrets.BackendGCPSM, map[secrets.Backend]secrets.Store{
		secrets.BackendGCPSM:   stub{name: "gcp"},
		secrets.BackendOpenBao: stub{name: "bao"},
	})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	got := reg.Backends()
	want := []secrets.Backend{secrets.BackendGCPSM, secrets.BackendOpenBao}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("Backends() = %v, want %v", got, want)
	}
	if reg.Default() != secrets.BackendGCPSM {
		t.Fatalf("Default() = %q, want gcpsm", reg.Default())
	}
}
