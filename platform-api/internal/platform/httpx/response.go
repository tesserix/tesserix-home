package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/reqid"
)

// StandardResponse is the envelope every response from this service carries.
//
// # It is go-shared's, deliberately
//
// #269 argues the platform API "should look like the other ~30 services rather
// than invent a house style", and the estate's shape is
// go-shared/middleware.StandardResponse: a boolean success, the payload under
// `data`, the failure under `error`, pagination under `meta`, plus a timestamp
// and a request id. Reproduced field for field so a client written against
// another Tesserix service is not surprised by this one. The module itself is
// not imported — the three reasons are recorded in errors.go and unchanged.
//
// # This REVERSED an earlier decision, and the reversal is the point
//
// The scaffold shipped the flat AppError shape — `{code, message, details}` at
// the top level — reasoning that it was the estate's error envelope. It is:
// go-shared's AppError really does serialise that way. What that reasoning
// missed is that AppError is what a HANDLER returns, not what a Tesserix
// service puts on the wire. Every one of them writes it through
// ErrorResponse, which nests it under `error` inside StandardResponse. So the
// flat shape matched half the estate's convention and contradicted the other
// half, and a client would have had to branch on which Tesserix service it was
// talking to — precisely the surprise the original decision existed to avoid.
//
// Reversed here rather than left as a known wart because the first module is
// the last cheap moment: after it, the shape is a contract products have
// pinned to, and changing it costs a version.
//
// # What is deliberately NOT copied
//
// go-shared's MetaData is offset-shaped — page, per_page, total_pages. See
// Meta below for why this service does not emit those.
type StandardResponse struct {
	Success bool `json:"success"`
	// Data is omitted on a failure, and Error on a success. Never both.
	Data  any           `json:"data,omitempty"`
	Error *ErrorDetails `json:"error,omitempty"`
	Meta  *Meta         `json:"meta,omitempty"`
	// Timestamp is when the response was produced, in UTC. Always present:
	// a field that appears only sometimes cannot be relied on by a log
	// pipeline, which is the only thing that reads it.
	Timestamp time.Time `json:"timestamp"`
	// RequestID correlates this response with the service's logs. Omitted only
	// when the request never passed through reqid.Middleware, which in a wired
	// service means never.
	RequestID string `json:"request_id,omitempty"`
}

// ErrorDetails is the failure half of the envelope: go-shared's ErrorDetails,
// which is AppError minus the HTTP status.
//
// The status is not here for the reason the flat envelope also kept it out —
// the response carries it already, and a body that restates it invites the two
// to disagree in a way no test would catch.
type ErrorDetails struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// Meta carries pagination.
//
// # Keyset, not offset, and why that is not a deviation worth apologising for
//
// go-shared's MetaData offers page / per_page / total / total_pages. This
// service emits cursors instead, because the console standardised on keyset in
// #240/#241 and #269 is explicit that "the API should not disagree with its own
// UI". Emitting a page number alongside a cursor would advertise a position
// this API cannot honour: there is no OFFSET behind it to jump to, so
// `?page=7` would either be ignored or quietly re-derived, and both are worse
// than not offering it.
//
// `total` keeps go-shared's spelling, because it means the same thing in both.
//
// # Why the counts are pointers
//
// The honest-totals half of #241. With `omitempty` on a plain int, a total of
// zero disappears from the body, and a client cannot distinguish "no rows
// match your filter" from "this endpoint does not report totals". Nil means
// not reported; a pointer to zero means zero, and the two are different
// answers.
type Meta struct {
	// NextCursor is a promise that another page exists in the reading
	// direction. Absent — not empty — when this is the last page, because an
	// empty cursor is a promise that resolves to nothing.
	NextCursor string `json:"next_cursor,omitempty"`
	// PreviousCursor is the same promise backwards. Absent on the first page.
	PreviousCursor string `json:"previous_cursor,omitempty"`
	// PrecedingCount is how many matching rows sort ahead of this page.
	// Counted in SQL, never inferred from a page number: a cursor carries no
	// position of its own, and this is what lets a client render "51–100 of
	// 128" without offset paging.
	PrecedingCount *int `json:"preceding_count,omitempty"`
	// Total is every row matching the filter, ignoring the page limit.
	Total *int64 `json:"total,omitempty"`
	// Limit is the page size actually applied, which is not always the one
	// asked for — see the clamp in the listing handler. Echoed so a client can
	// see its request was narrowed rather than inferring it from a short page.
	Limit int `json:"limit,omitempty"`
}

// WriteData writes a success carrying a payload and no pagination.
func WriteData(w http.ResponseWriter, r *http.Request, status int, data any, log *slog.Logger) {
	WriteMeta(w, r, status, data, nil, log)
}

// WriteMeta writes a success carrying a payload and its pagination.
func WriteMeta(w http.ResponseWriter, r *http.Request, status int, data any, meta *Meta, log *slog.Logger) {
	write(w, r, status, StandardResponse{
		Success: true,
		Data:    data,
		Meta:    meta,
	}, log)
}

// WriteError writes the envelope for err at the status err names.
//
// Anything that is not already an Error becomes a generic 500 — see From. The
// original belongs in the log, which is the caller's job, because only the
// caller knows what it was doing.
func WriteError(w http.ResponseWriter, r *http.Request, err error, log *slog.Logger) {
	envelope := From(err)
	write(w, r, envelope.StatusCode, StandardResponse{
		Success: false,
		Error: &ErrorDetails{
			Code:    envelope.Code,
			Message: envelope.Message,
			Details: envelope.Details,
		},
	}, log)
}

// now is a variable so the timestamp can be pinned in a test without every
// caller taking a clock. Never reassigned outside tests.
var now = func() time.Time { return time.Now().UTC() }

// write completes the envelope and puts it on the wire.
//
// The encode happens into a buffer first. Encoding straight to the
// ResponseWriter commits the status code before it can fail, so a marshalling
// error mid-write produces a 200 with a truncated body — a corrupt success,
// which is worse than an honest 500.
func write(w http.ResponseWriter, r *http.Request, status int, body StandardResponse, log *slog.Logger) {
	body.Timestamp = now()
	if r != nil {
		body.RequestID = reqid.FromContext(r.Context())
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		// The payload is unencodable — a handler bug, not a client one. The
		// fallback is still the envelope, so a client parsing this service's
		// responses does not meet a different shape on the one path it is
		// least able to anticipate.
		log.Error("encoding response failed",
			slog.Any("error", err),
			slog.String("request_id", body.RequestID),
		)
		fallback, _ := json.Marshal(StandardResponse{
			Success:   false,
			Error:     &ErrorDetails{Code: CodeInternal, Message: "request failed"},
			Timestamp: body.Timestamp,
			RequestID: body.RequestID,
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write(fallback)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(encoded); err != nil {
		// The client is gone. Nothing to do but record it — the status is
		// already sent, so there is no error to return.
		log.Debug("writing response failed", slog.Any("error", err))
	}
}
