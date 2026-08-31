// Package secrets holds the vocabulary every secret backend shares: how a
// secret is addressed, what may be said about it, and the errors a backend may
// report. Nothing here can carry a secret value.
package secrets

import (
	"errors"
	"time"
)

var (
	ErrNotFound       = errors.New("secrets: path not found")
	ErrForbidden      = errors.New("secrets: denied by backend policy")
	ErrUnknownBackend = errors.New("secrets: backend is not enabled")
	// ErrConflict is a write whose expected version is no longer the current
	// one: someone else wrote the secret while this one was being edited.
	ErrConflict = errors.New("secrets: the secret changed while you were editing it")
)

// FlatValueKey names the single field a secret with no namespace or app holds.
// Its payload is the value itself, so the console needs one agreed name to
// carry it between the form and the backend.
const FlatValueKey = "value"

type Entry struct {
	Name     string `json:"name"`
	IsFolder bool   `json:"isFolder"`
}

// Secret describes a secret without carrying its values. There is no type in
// this package that can hold a secret value read back out of a backend, and no
// method that returns one.
type Secret struct {
	Ref       SecretRef `json:"ref"`
	Path      string    `json:"path"`
	Version   int       `json:"version"`
	Keys      []string  `json:"keys"`
	CreatedAt time.Time `json:"createdAt,omitempty"`
	UpdatedAt time.Time `json:"updatedAt,omitempty"`
}

type Version struct {
	Version   int       `json:"version"`
	CreatedAt time.Time `json:"createdAt,omitempty"`
	Destroyed bool      `json:"destroyed"`
	Deleted   bool      `json:"deleted"`
}
