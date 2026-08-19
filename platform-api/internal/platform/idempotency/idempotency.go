// Package idempotency makes a retried write land once. Kernel, not a module —
// every write verb in the service uses it, and it depends on no module.
//
// # The problem it solves
//
// Neither of the tickets module's writes has a natural uniqueness constraint.
// A reply is append-only free text and support legitimately asks the same
// question twice, so the database cannot tell a retry from a repeat. A timeout
// on a request that actually succeeded, a double-submitted form, or a retry at
// the ingress all produce two identical messages on a merchant's ticket, with
// nothing to say which was intended.
//
// The uniqueness that matters is of the REQUEST, not of its content, and only
// the caller can assert that. So the caller supplies an Idempotency-Key and
// this package remembers what that key produced.
//
// # The ordering, which is the whole guarantee
//
// The record is written in the SAME transaction as the operation. A key in the
// table therefore always corresponds to a committed write, and a rolled-back
// write leaves no key behind. Recording first and writing after would refuse
// the retry of a request that never landed — worse than not having the feature,
// because the caller would be told their write was already applied.
//
// # Optional, deliberately
//
// A request with no key is performed normally. Requiring one would break every
// caller on the day this shipped, including the console. What the convention
// says is that a client that wants exactly-once gets it by asking; a client
// that does not ask gets what it gets today.
package idempotency

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Header is the wire name. Stripe's spelling, which is the de facto one.
const Header = "Idempotency-Key"

// maxKeyLength bounds what a caller may store. The value is caller-controlled
// and lands in a primary key; an unbounded one is a way to write arbitrary
// data into this service's database under the guise of a header.
const maxKeyLength = 255

var (
	// ErrInvalidKey means the header was present and unusable. Distinct from
	// absent: a caller that meant to be idempotent and got the header wrong
	// must be told, not silently treated as one that did not ask.
	ErrInvalidKey = errors.New("idempotency key is not usable")

	// ErrKeyReused means the key was already used for a DIFFERENT request.
	// That is not a retry — it is a client bug or a replay, and returning the
	// first response to it would silently discard the second request.
	ErrKeyReused = errors.New("idempotency key was used for a different request")
)

// Querier is the subset of pgx a claim needs.
//
// An interface so a test can drive this against a transaction or a pool
// without either being named in the signature. The signatures are pgx's own,
// including pgconn.CommandTag — Go matches interface methods exactly, so a
// locally-declared stand-in for the return type would be satisfied by nothing.
//
// It deliberately does NOT constrain the caller to a transaction, because Go
// cannot express that: pgx.Tx and pgxpool.Pool have the same methods. Record's
// doc comment says which is required, and the tests assert the consequence.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Key identifies one request for replay purposes.
type Key struct {
	// Value is the caller's header, verbatim.
	Value string
	// Principal is the Zitadel subject that presented it. Part of the identity
	// so one caller's key cannot collide with, or be replayed by, another's —
	// without it a key is a guessable cross-principal handle onto somebody
	// else's stored response.
	Principal string
	// Operation is the dotted action name, matching the audit trail's
	// vocabulary. Recorded so a key reused across two different endpoints is a
	// conflict rather than the wrong stored response replayed at the wrong one.
	Operation string
	// Digest is a hash of the request body. Never the body itself: a reply's
	// text is the merchant's conversation, and storing it here would create a
	// second copy with a different retention — the line migration 0018 drew
	// for console_audit_log.metadata.
	Digest string
}

// FromRequest reads the header and builds a Key.
//
// The bool reports whether the caller asked for idempotency at all. It is not
// an error to omit the header; it is an error to send one that cannot be used.
func FromRequest(r *http.Request, principal, operation string, body []byte) (Key, bool, error) {
	raw := r.Header.Get(Header)
	if raw == "" {
		return Key{}, false, nil
	}
	if len(raw) > maxKeyLength {
		return Key{}, true, fmt.Errorf("%w: longer than %d characters", ErrInvalidKey, maxKeyLength)
	}
	for i := 0; i < len(raw); i++ {
		// Printable ASCII. The value is stored and echoed in logs; a control
		// character in it is not an identifier.
		if raw[i] < 0x21 || raw[i] > 0x7e {
			return Key{}, true, fmt.Errorf("%w: contains a character that is not printable ASCII", ErrInvalidKey)
		}
	}
	if principal == "" {
		// Unreachable through the router — every write is authenticated — and
		// guarded anyway, because a key scoped to an empty principal would be
		// shared by every caller that reached this state.
		return Key{}, true, fmt.Errorf("%w: no principal to scope it to", ErrInvalidKey)
	}
	sum := sha256.Sum256(body)
	return Key{
		Value:     raw,
		Principal: principal,
		Operation: operation,
		Digest:    hex.EncodeToString(sum[:]),
	}, true, nil
}

// Stored is what a previous attempt with this key produced.
type Stored struct {
	Status int
	Body   []byte
}

// Lookup returns the response a previous attempt with this key produced, or
// nil when the key is new.
//
// ErrKeyReused when the key exists against a different operation or a
// different body. Checked here rather than left to the caller because the
// distinction is the entire safety property: replaying a stored response to a
// request that differs from the one that produced it discards a write and
// reports success.
func Lookup(ctx context.Context, q Querier, key Key) (*Stored, error) {
	var (
		operation string
		digest    string
		status    int
		body      string
	)
	err := q.QueryRow(ctx,
		`SELECT operation, request_digest, response_status, response_body
		   FROM platform_api_idempotency
		  WHERE principal = $1 AND idempotency_key = $2`,
		key.Principal, key.Value,
	).Scan(&operation, &digest, &status, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading idempotency record: %w", err)
	}
	if operation != key.Operation {
		return nil, fmt.Errorf("%w: first used for %s, now %s", ErrKeyReused, operation, key.Operation)
	}
	if digest != key.Digest {
		return nil, fmt.Errorf("%w: same key, different body", ErrKeyReused)
	}
	return &Stored{Status: status, Body: []byte(body)}, nil
}

// Record stores what this attempt produced.
//
// MUST be called on the same transaction as the operation it describes — see
// the package comment. Passing a pool would record a key for a write that may
// still roll back.
//
// It reports false when the key was claimed by a concurrent transaction that
// committed first. The caller must then ROLL BACK its own work — which is the
// duplicate — and re-read the stored response outside the transaction.
//
// Handling the race this way rather than by reserving the key up front is a
// deliberate trade. Reserving first would need a nullable response and a
// second UPDATE, and would leave an orphaned reservation behind any write that
// failed. Doing the work and discarding it on the rare loss costs one wasted
// transaction, and the request rate here is bounded by operators typing.
func Record(ctx context.Context, q Querier, key Key, status int, body []byte) (bool, error) {
	tag, err := q.Exec(ctx,
		`INSERT INTO platform_api_idempotency
		   (principal, idempotency_key, operation, request_digest, response_status, response_body)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (principal, idempotency_key) DO NOTHING`,
		key.Principal, key.Value, key.Operation, key.Digest, status, string(body),
	)
	if err != nil {
		return false, fmt.Errorf("recording idempotency key: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}
