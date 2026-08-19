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
