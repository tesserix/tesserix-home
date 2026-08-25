package federation

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// Mark8ly's request-signing scheme for /admin/* calls (#334).
//
// This is the CALLER's half. The reference implementation is mark8ly's
// services/marketplace-api/internal/handlers/platformadmin/signature.go, and
// the scheme is specified nowhere else — not in a doc, not in the integration
// contract. What keeps the two halves honest is testdata/vectors.json, copied
// here byte-for-byte from theirs. Changing anything in this file without the
// vectors still passing means the console silently 401s against production,
// because every rejection on their side is deliberately one opaque status.
//
// Only Sign is implemented. We never verify: nothing signs requests TO the
// platform API with this scheme, and an unused Verify would be an untested
// constant-time comparison sitting in a security-relevant file.
//
// Three properties are load-bearing and each fails as a silent 401 rather
// than as an error, which is why they are called out rather than left to be
// inferred from the code:
//
//   - The signed Path is the percent-DECODED path — net/http's URL.Path,
//     never RawPath or EscapedPath, and never the raw wire target. Sign
//     "/tenants/t one" with a real space, not "/tenants/t%20one". Client.Get
//     gets this right by construction: it builds the request first and signs
//     from req.URL, letting net/url do the decoding.
//   - Query values are escaped with application/x-www-form-urlencoded
//     semantics — a space becomes "+" and a literal "+" becomes "%2B". Go's
//     url.QueryEscape does this natively, so this half is free for us; it is
//     noted because the same scheme implemented in TypeScript against
//     encodeURIComponent would produce "%20" and 401 on every query value
//     containing a space.
//   - Method, Path, Timestamp, Nonce, Operator and Capability may not contain
//     '\n' or '\r'. The canonical string joins with "\n" and carries no
//     length prefixes, so Operator="a", Capability="b\nc" would otherwise
//     produce the same bytes as Operator="a\nb", Capability="c". Mark8ly
//     enforces this; enforcing it here too turns a collision into an error at
//     the point of signing instead of a 401 from a remote service.

// Header names carried by every signed platform call. These must match
// mark8ly's platformadmin constants exactly.
const (
	headerOperator   = "X-Platform-Operator"
	headerCapability = "X-Platform-Capability"
	headerTimestamp  = "X-Platform-Timestamp"
	headerNonce      = "X-Platform-Nonce"
	headerSignature  = "X-Platform-Signature"
)

// SignatureInput is everything the HMAC covers. Operator and capability are
// signed so neither can be substituted after signing — they are the
// attribution the whole federated surface exists to record.
//
// Path must be the decoded URL.Path. See the note above.
type SignatureInput struct {
	Method     string
	Path       string
	RawQuery   string
	Body       []byte
	Timestamp  string
	Nonce      string
	Operator   string
	Capability string
}

// CanonicalQuery renders a query string deterministically: keys sorted, then
// values within a repeated key sorted, each percent-encoded, joined by "&".
// Both sides must agree byte-for-byte, so nothing here may depend on map
// iteration order.
func CanonicalQuery(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return "", fmt.Errorf("federation: parse query: %w", err)
	}

	keys := make([]string, 0, len(values))
	total := 0
	for k, vs := range values {
		keys = append(keys, k)
		total += len(vs)
	}
	sort.Strings(keys)

	parts := make([]string, 0, total)
	for _, k := range keys {
		vs := append([]string(nil), values[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, url.QueryEscape(k)+"="+url.QueryEscape(v))
		}
	}
	return strings.Join(parts, "&"), nil
}

// checkNoLineBreaks guards the fields joined by "\n" that are not otherwise
// protected from ambiguity. RawQuery is percent-escaped by CanonicalQuery and
// Body is folded into a fixed-width hash, so neither needs the check. Order is
// fixed so a multi-field violation always names the same field first.
func checkNoLineBreaks(in SignatureInput) error {
	fields := []struct{ name, value string }{
		{"method", in.Method},
		{"path", in.Path},
		{"timestamp", in.Timestamp},
		{"nonce", in.Nonce},
		{"operator", in.Operator},
		{"capability", in.Capability},
	}
	for _, f := range fields {
		if strings.ContainsAny(f.value, "\n\r") {
			return fmt.Errorf("federation: %s must not contain a newline or carriage return", f.name)
		}
	}
	return nil
}

// CanonicalString builds the string the HMAC covers: eight fields joined by
// "\n". The body is included as a hash rather than inline so a captured
// signature cannot be lifted onto a different payload. An absent body hashes
// as the empty string.
func CanonicalString(in SignatureInput) (string, error) {
	if err := checkNoLineBreaks(in); err != nil {
		return "", err
	}

	query, err := CanonicalQuery(in.RawQuery)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(in.Body)

	return strings.Join([]string{
		strings.ToUpper(strings.TrimSpace(in.Method)),
		in.Path,
		query,
		hex.EncodeToString(sum[:]),
		in.Timestamp,
		in.Nonce,
		in.Operator,
		in.Capability,
	}, "\n"), nil
}

// Sign returns the lowercase hex HMAC-SHA256 of the canonical string.
//
// It rejects an empty secret. LoadRegistry already refuses to boot without
// one, so this is the second of two gates rather than the only one — but the
// failure it prevents (a valid-looking HMAC over "" that 401s at the far end
// with no local symptom) is expensive enough to be worth both.
func Sign(secret string, in SignatureInput) (string, error) {
	if secret == "" {
		return "", fmt.Errorf("federation: signing secret must not be empty")
	}

	canonical, err := CanonicalString(in)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil)), nil
}
