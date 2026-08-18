// Package httpx holds the platform API's HTTP conventions: the error envelope
// and the helpers that write it. It is kernel, not a module — every module
// depends on it and it depends on no module.
//
// # Why this mirrors go-shared rather than importing it
//
// #269 argues the platform API "should look like the other ~30 services rather
// than invent a house style", and the estate's shape is go-shared's AppError:
// a stable string Code, a human Message, an HTTP status that is not serialised,
// and optional Details. That shape is reproduced here field for field, so a
// client written against another Tesserix service is not surprised.
//
// The module itself is not imported. Decided by Mahesh on 2026-08-18, and it
// holds up on its own for three reasons recorded on #277:
//
//  1. github.com/tesserix/go-shared is a PRIVATE repository. Importing it means
//     GOPRIVATE plus a credential in CI and in the Docker build. This
//     repository just finished removing its npm token from the console image
//     when @tesserix/* moved to the public registry; adding a Go token back is
//     a step in the opposite direction.
//  2. Its authentication and authorization packages are GIP and OpenFGA. This
//     service authenticates through Zitadel (ADR-003 D8) and enforces #261's
//     capability vocabulary. Taking the module for its error codes means
//     carrying the auth model the ADR has just decided against.
//  3. secret-service — the only other Go service of this generation, and the
//     precedent ADR-003 cites for Node and Go coexisting here — does not depend
//     on go-shared either.
//
// One reason that was raised and does NOT hold, recorded so it is not
// rediscovered as fact: go-shared is not dormant. The remote was pushed
// 2026-08-14 and carries tags through v1.8.3 — it is local checkouts of it in
// this estate that go stale. The decision does not rest on that.
//
// The cost is duplication of about eighty lines that rarely change. The
// alternative was a private-module credential in two build paths and an auth
// model this service does not use. If go-shared is ever split so the envelope
// ships without the auth packages, or if it goes public, this decision is worth
// revisiting — that is the trigger, not a general preference for sharing.
package httpx

import (
	"errors"
	"fmt"
	"net/http"
)

// Error is the platform API's error envelope. Field-compatible with
// go-shared's AppError, deliberately — see the package comment.
//
// StatusCode is not serialised: it is carried by the HTTP response itself, and
// a body that restates it invites the two to disagree.
type Error struct {
	Code       string         `json:"code"`
	Message    string         `json:"message"`
	StatusCode int            `json:"-"`
	Details    map[string]any `json:"details,omitempty"`
}

func (e Error) Error() string { return e.Message }

// Error codes. The estate's spelling, so a client that already handles
// NOT_FOUND from another service handles it here.
const (
	CodeUnauthorized  = "UNAUTHORIZED"
	CodeForbidden     = "FORBIDDEN"
	CodeBadRequest    = "BAD_REQUEST"
	CodeNotFound      = "NOT_FOUND"
	CodeConflict      = "CONFLICT"
	CodeValidation    = "VALIDATION_FAILED"
	CodeInternal      = "INTERNAL_SERVER_ERROR"
	CodeUnavailable   = "SERVICE_UNAVAILABLE"
	CodeDatabaseError = "DATABASE_ERROR"
)

func Unauthorized(message string) Error {
	return Error{Code: CodeUnauthorized, Message: message, StatusCode: http.StatusUnauthorized}
}

func Forbidden(message string) Error {
	return Error{Code: CodeForbidden, Message: message, StatusCode: http.StatusForbidden}
}

func BadRequest(message string) Error {
	return Error{Code: CodeBadRequest, Message: message, StatusCode: http.StatusBadRequest}
}

func NotFound(message string) Error {
	return Error{Code: CodeNotFound, Message: message, StatusCode: http.StatusNotFound}
}

func Conflict(message string) Error {
	return Error{Code: CodeConflict, Message: message, StatusCode: http.StatusConflict}
}

func Validation(message string, details map[string]any) Error {
	return Error{
		Code:       CodeValidation,
		Message:    message,
		StatusCode: http.StatusUnprocessableEntity,
		Details:    details,
	}
}

// Internal is the response for a fault the caller cannot act on.
//
// The cause is deliberately NOT placed in Message. Whatever a handler wraps —
// a driver error, a failed query — is written to the log, and the client is
// told only that the request failed. A database error text reaching an API
// response is how schema and query shape leak to callers.
func Internal(message string) Error {
	return Error{Code: CodeInternal, Message: message, StatusCode: http.StatusInternalServerError}
}

// Unavailable means a dependency this request needed is not reachable.
//
// Distinct from Internal on purpose, and #198 is the reason it exists from day
// one: an unconfigured upstream answering as a hard error is what makes a
// console surface show "broken" where it should show "not measured". A caller
// can only draw that distinction if the API draws it first.
func Unavailable(message string) Error {
	return Error{Code: CodeUnavailable, Message: message, StatusCode: http.StatusServiceUnavailable}
}

// From narrows any error to the envelope.
//
// An error that is already an Error keeps its code, status and details. Anything
// else becomes a generic 500 with a fixed message — never the underlying text,
// for the reason given on Internal. Callers log the original separately.
func From(err error) Error {
	if err == nil {
		return Internal("request failed")
	}
	var e Error
	if errors.As(err, &e) {
		if e.StatusCode == 0 {
			e.StatusCode = http.StatusInternalServerError
		}
		return e
	}
	return Internal("request failed")
}

// WithDetails returns a copy carrying the given details.
//
// A copy, not a mutation: the constructors above are frequently assigned to
// package-level sentinels, and mutating one in a handler would edit every
// future response that shares it.
func (e Error) WithDetails(details map[string]any) Error {
	clone := make(map[string]any, len(e.Details)+len(details))
	for k, v := range e.Details {
		clone[k] = v
	}
	for k, v := range details {
		clone[k] = v
	}
	e.Details = clone
	return e
}

// Wrap attaches context to a non-envelope error for the log, leaving the
// envelope the client sees untouched.
func Wrap(err error, format string, args ...any) error {
	return fmt.Errorf(fmt.Sprintf(format, args...)+": %w", err)
}
