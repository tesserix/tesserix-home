// Package reqid carries one identifier from the edge of a request to every
// log line and response body it produces.
//
// # Why its own package rather than a helper in httpx
//
// Two kernel packages need it and neither may import the other. httpx builds
// the router and therefore imports auth; auth writes its own refusals and
// would have to import httpx to read a request id living there. That is the
// cycle auth's own comment anticipated when it hand-wrote its refusal bodies
// "to keep this package free of a dependency on httpx".
//
// A third package both may depend on resolves it without either of them
// growing a dependency on the other, and it stays true when a fourth kernel
// package needs the same value.
//
// # Why the identifier exists at all
//
// go-shared's StandardResponse carries `request_id`, and the platform API
// adopts that envelope (see httpx/response.go). A field that is always empty
// is worse than no field: it invites a client to build correlation on top of
// a blank column. This makes it real — one id, echoed in the body and in the
// response header, and available to every log line in between.
package reqid

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
)

// Header is the wire name, matching the convention Istio and the estate's
// other services already emit.
const Header = "X-Request-Id"

type contextKey struct{}

var key contextKey

// maxInboundLength bounds what a caller may impose on this service's logs.
//
// The inbound value is trusted enough to correlate with and no further: it is
// attacker-controlled text that lands in log lines and response bodies, so an
// unbounded one is a way to write a megabyte into every log aggregator that
// indexes this service. Anything longer is replaced rather than truncated —
// a truncated id silently stops matching the caller's own record, which is a
// worse failure than an obviously different one.
const maxInboundLength = 128

// Middleware attaches a request id, generating one when the caller sent none.
//
// It is the outermost middleware in the chain on purpose: a request refused by
// authentication still gets an id, because a 401 an operator cannot correlate
// is exactly the request someone will ask about.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(Header)
		if !usable(id) {
			id = generate()
		}
		// Echoed on the response too, so a caller holding only the HTTP
		// exchange — a browser network tab, a curl -i — can quote the id
		// without parsing the body. Set before next runs, because a handler
		// that has already written its headers cannot add one.
		w.Header().Set(Header, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), key, id)))
	})
}

// usable rejects an inbound value that cannot safely be carried through.
//
// Printable ASCII only: the id is written into a JSON body and a response
// header, and a control character in a header value is a response-splitting
// primitive rather than an identifier.
func usable(id string) bool {
	if id == "" || len(id) > maxInboundLength {
		return false
	}
	for i := 0; i < len(id); i++ {
		if id[i] < 0x20 || id[i] > 0x7e {
			return false
		}
	}
	return true
}

// FromContext returns the request's id, or "" when there is none.
//
// The empty string rather than a bool: every caller's response to "no id" is
// to omit it, and a bool nobody branches on is a bool everybody ignores.
func FromContext(ctx context.Context) string {
	id, _ := ctx.Value(key).(string)
	return id
}

// generate produces a 128-bit random id.
//
// Not a UUID, and not a counter. A UUID would mean a dependency or a
// hand-rolled version-4 layout for a value nothing parses; a counter would
// collide the moment this service runs more than one replica, which Knative
// makes routine.
func generate() string {
	var b [16]byte
	// crypto/rand.Read is documented never to fail since Go 1.24 — it panics
	// internally if the system source is unavailable rather than returning an
	// error, so there is no failure branch to write here.
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// LogHandler adds the request id to every log record made with a context.
//
// # Why a handler rather than an attribute at each call site
//
// This was written the other way first, and running the service showed why
// that fails. Every `log.WarnContext(ctx, …)` call in the service passed a
// context carrying an id, and not one log line contained it — slog's handlers
// do not read context values, so the id was available at every call site and
// present at none of them.
//
// The two lines that mattered most were the ones with the least: the auth
// package's "token rejected" and the tickets handler's "request failed". Both
// exist precisely because the client is told deliberately less than the log
// knows — a 401 says nothing about which check failed, a 500 says nothing
// about the driver error behind it — and the request id is the ONLY thing
// joining what the caller saw to what actually happened. Without it the
// distinct error values that package works so hard to keep separate are
// unreachable in practice: an operator holding a request id has no line to
// find.
//
// Adding the attribute by hand at each site would have fixed those two and
// silently missed the next one. Doing it in the handler means a log call
// cannot forget.
func LogHandler(inner slog.Handler) slog.Handler { return handler{inner: inner} }

// handler keeps its own record of the groups opened on it rather than passing
// them to the wrapped handler.
//
// That is the whole trick, and the first version did not do it: delegating
// WithGroup means the request id is added INSIDE whatever group is open, and an
// id nested three keys deep is one a log query will not find. Holding the
// groups here lets the id stay at the top level while the caller's attributes
// are nested where they asked for them.
type handler struct {
	inner  slog.Handler
	groups []string
	// attrs are those added AFTER a group was opened, which therefore belong
	// inside it. Attributes added before any group are passed straight to the
	// wrapped handler, where they already sit at the top level.
	attrs []slog.Attr
}

func (h handler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h handler) Handle(ctx context.Context, record slog.Record) error {
	id := FromContext(ctx)

	if len(h.groups) == 0 {
		if id == "" {
			return h.inner.Handle(ctx, record)
		}
		// Cloned, not mutated: Handle must not modify the record it is given,
		// and a chained handler downstream may hold a reference to it.
		record = record.Clone()
		record.AddAttrs(slog.String("request_id", id))
		return h.inner.Handle(ctx, record)
	}

	// A group is open, so the caller's attributes are nested and the id is not.
	nested := make([]any, 0, len(h.attrs)+record.NumAttrs())
	for _, attr := range h.attrs {
		nested = append(nested, attr)
	}
	record.Attrs(func(attr slog.Attr) bool {
		nested = append(nested, attr)
		return true
	})
	// Innermost group first, wrapping outwards.
	grouped := slog.Group(h.groups[len(h.groups)-1], nested...)
	for i := len(h.groups) - 2; i >= 0; i-- {
		grouped = slog.Group(h.groups[i], grouped)
	}

	out := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	if id != "" {
		out.AddAttrs(slog.String("request_id", id))
	}
	out.AddAttrs(grouped)
	return h.inner.Handle(ctx, out)
}

func (h handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(h.groups) == 0 {
		// No group open, so these belong at the top level — which is exactly
		// where the wrapped handler will put them.
		return handler{inner: h.inner.WithAttrs(attrs), groups: h.groups, attrs: h.attrs}
	}
	return handler{
		inner:  h.inner,
		groups: h.groups,
		attrs:  append(append([]slog.Attr(nil), h.attrs...), attrs...),
	}
}

// WithGroup records the group instead of opening it on the wrapped handler.
//
// One imprecision, stated rather than hidden: attributes added between two
// WithGroup calls end up in the innermost group rather than the one that was
// open when they were added. Correcting it needs a tree of interleaved steps,
// and nothing in this service opens a group at all — the logger is one JSON
// handler built in cmd/server. Worth fixing if that changes; not worth the
// machinery before it does.
func (h handler) WithGroup(name string) slog.Handler {
	if name == "" {
		// slog requires an empty group name to be a no-op.
		return h
	}
	return handler{
		inner:  h.inner,
		groups: append(append([]string(nil), h.groups...), name),
		attrs:  h.attrs,
	}
}
