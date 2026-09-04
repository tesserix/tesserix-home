// Package httpx holds the platform API's HTTP conventions: the response
// envelope, the error type, and the helpers that write both. It is kernel, not
// a module — every module depends on it and it depends on no module.
//
// # Why this mirrors go-shared rather than importing it
//
// #269 argues the platform API "should look like the other ~30 services rather
// than invent a house style", and the estate's shapes are go-shared's AppError
// and StandardResponse. Both are reproduced here field for field — AppError as
// Error below, StandardResponse in response.go — so a client written against
// another Tesserix service is not surprised.
//
// Error is the type a handler RETURNS. It is not the wire format: like every
// other service in the estate, this one nests it under `error` inside
// StandardResponse on the way out. The scaffold originally serialised Error
// flat at the top level, which matched AppError and contradicted every actual
// Tesserix response; response.go records the reversal and why it was made at
// the first module rather than after.
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
// rediscovered as fact: go-shared is not dormant. Checked 2026-08-18 — the
// remote was pushed 2026-08-14, and the local checkout is three commits AHEAD
// of origin/main carrying three unpushed tags (v1.8.4, v1.9.0, v1.9.1) against
// a remote that stops at v1.8.3. The quiet remote is unpushed work, not an
// abandoned library. The decision does not rest on activity either way.
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

// Error is what a handler returns to say what went wrong. Field-compatible
// with go-shared's AppError, deliberately — see the package comment.
//
// It carries no JSON tags. That is not an oversight: WriteError projects it
// into ErrorDetails, and a type that could serialise itself would eventually be
// handed to json.Marshal directly by a handler in a hurry, producing one
// response in this service that does not match the others. Removing the tags
// makes that a compile-time absence rather than a review comment.
//
// StatusCode never reaches the wire in any form: it is carried by the HTTP
// response itself, and a body that restates it invites the two to disagree.
type Error struct {
	Code       string
	Message    string
	StatusCode int
	Details    map[string]any
}

func (e Error) Error() string { return e.Message }

// Error codes. The estate's spelling, so a client that already handles
// NOT_FOUND from another service handles it here.
const (
	CodeUnauthorized    = "UNAUTHORIZED"
	CodeForbidden       = "FORBIDDEN"
	CodeBadRequest      = "BAD_REQUEST"
	CodeNotFound        = "NOT_FOUND"
	CodeConflict        = "CONFLICT"
	CodeValidation      = "VALIDATION_FAILED"
	CodeInternal        = "INTERNAL_SERVER_ERROR"
	CodeUnavailable     = "SERVICE_UNAVAILABLE"
	CodeNotImplemented  = "NOT_IMPLEMENTED"
	CodeDatabaseError   = "DATABASE_ERROR"
	CodeExternalService = "EXTERNAL_SERVICE_ERROR"
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

// NotImplemented means this deployment does not measure the thing being asked
// for at all.
//
// Distinct from Unavailable, and the distinction is the whole point:
// Unavailable says "we measure this and cannot reach it right now",
// NotImplemented says "nothing here was ever configured to produce it". A
// surface that cannot tell those apart renders an unconfigured estate as
// "nothing happened", which is the failure #198 records and which the console
// maps to `instrumentation-unavailable` on exactly this status.
func NotImplemented(message string) Error {
	return Error{Code: CodeNotImplemented, Message: message, StatusCode: http.StatusNotImplemented}
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

// ExternalService means a dependency ANSWERED, and its answer was unusable.
//
// The third point of the triangle Unavailable and NotImplemented already form,
// and go-shared spells it the same way for the same reason — its
// ErrCodeExternalService comment draws exactly this line: Unavailable is "not
// reached or not configured", this one is "reached, and it answered with an
// error". Both are 503, because from the caller's side the request cannot be
// served either way; only the code and the message say which happened.
//
// It exists here because a product deviating from the contract was being
// reported as an outage: a §3.1 metrics map arriving as `{}` reached the
// console as "the product could not be reached", which sends an operator to
// check a network path that is fine and away from the product that is wrong
// (#546).
func ExternalService(message string) Error {
	return Error{
		Code:       CodeExternalService,
		Message:    message,
		StatusCode: http.StatusServiceUnavailable,
	}
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
