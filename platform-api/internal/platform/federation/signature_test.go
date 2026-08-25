package federation

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// vector is one row of testdata/vectors.json, which is a byte-for-byte copy of
// mark8ly's own testdata/vectors.json — the artifact their signature.go package
// doc names as the specification for this scheme. Copied rather than
// re-derived: a fixture we generated from our own implementation would agree
// with itself and prove nothing.
//
// RequestTarget is the raw wire form. It is deliberately NOT what gets signed
// — Path is — and is carried here only so the encoded-path trap stays visible
// to whoever reads this next.
type vector struct {
	Name          string `json:"name"`
	Secret        string `json:"secret"`
	Method        string `json:"method"`
	RequestTarget string `json:"request_target"`
	Path          string `json:"path"`
	RawQuery      string `json:"raw_query"`
	Body          string `json:"body"`
	Timestamp     string `json:"timestamp"`
	Nonce         string `json:"nonce"`
	Operator      string `json:"operator"`
	Capability    string `json:"capability"`
	Canonical     string `json:"canonical"`
	Signature     string `json:"signature"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("reading vectors: %v", err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("decoding vectors: %v", err)
	}
	if len(vs) != 4 {
		t.Fatalf("got %d vectors, want the 4 published on mark8ly#275", len(vs))
	}
	return vs
}

func (v vector) input() SignatureInput {
	var body []byte
	if v.Body != "" {
		body = []byte(v.Body)
	}
	return SignatureInput{
		Method:     v.Method,
		Path:       v.Path,
		RawQuery:   v.RawQuery,
		Body:       body,
		Timestamp:  v.Timestamp,
		Nonce:      v.Nonce,
		Operator:   v.Operator,
		Capability: v.Capability,
	}
}

// TestCanonicalStringMatchesTheGoldenVectors asserts the canonical string
// before the signature. Both are checked because only one of them localises a
// failure: a signature mismatch says "something upstream is wrong", while the
// canonical string says which of the eight fields it was.
func TestCanonicalStringMatchesTheGoldenVectors(t *testing.T) {
	for _, v := range loadVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			got, err := CanonicalString(v.input())
			if err != nil {
				t.Fatalf("CanonicalString: %v", err)
			}
			if got != v.Canonical {
				t.Errorf("canonical string mismatch\n got: %q\nwant: %q", got, v.Canonical)
			}
		})
	}
}

func TestSignMatchesTheGoldenVectors(t *testing.T) {
	for _, v := range loadVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			got, err := Sign(v.Secret, v.input())
			if err != nil {
				t.Fatalf("Sign: %v", err)
			}
			if got != v.Signature {
				t.Errorf("signature = %q, want %q", got, v.Signature)
			}
			if got != strings.ToLower(got) {
				t.Errorf("signature %q is not lowercase hex", got)
			}
		})
	}
}

// TestSignRejectsAnEmptySecret pins the fail-closed half of the contract. An
// unconfigured secret reaching this layer is a misconfiguration; producing a
// valid-looking HMAC from "" would turn it into a silent 401 at the far end
// instead of a loud failure here.
func TestSignRejectsAnEmptySecret(t *testing.T) {
	if _, err := Sign("", SignatureInput{Method: "GET", Path: "/x"}); err == nil {
		t.Fatal("an empty secret must be refused, not signed with")
	}
}

// TestCanonicalStringRejectsLineBreaks covers the field-collision the "\n"
// join would otherwise allow: Operator="a", Capability="b\nc" produces the
// same bytes as Operator="a\nb", Capability="c". Mark8ly enforces this; we
// enforce it too rather than relying on their rejection, because our failure
// would present as an unexplained 401.
func TestCanonicalStringRejectsLineBreaks(t *testing.T) {
	base := SignatureInput{
		Method: "GET", Path: "/x", Timestamp: "1755859200",
		Nonce: "n", Operator: "op", Capability: "cap",
	}
	for _, tc := range []struct {
		field  string
		mutate func(*SignatureInput)
	}{
		{"method", func(in *SignatureInput) { in.Method = "GE\nT" }},
		{"path", func(in *SignatureInput) { in.Path = "/x\ny" }},
		{"timestamp", func(in *SignatureInput) { in.Timestamp = "17558\r59200" }},
		{"nonce", func(in *SignatureInput) { in.Nonce = "n\nn" }},
		{"operator", func(in *SignatureInput) { in.Operator = "a\nb" }},
		{"capability", func(in *SignatureInput) { in.Capability = "b\nc" }},
	} {
		t.Run(tc.field, func(t *testing.T) {
			in := base
			tc.mutate(&in)
			if _, err := CanonicalString(in); err == nil {
				t.Fatalf("%s containing a line break must be refused", tc.field)
			}
		})
	}
}

// TestCanonicalQueryIsOrderIndependent is the property the vectors only
// sample. Both sides must agree byte-for-byte, and the caller's parameter
// order is not something this package controls.
func TestCanonicalQueryIsOrderIndependent(t *testing.T) {
	a, err := CanonicalQuery("b=2&a=z&a=a")
	if err != nil {
		t.Fatalf("CanonicalQuery: %v", err)
	}
	b, err := CanonicalQuery("a=a&b=2&a=z")
	if err != nil {
		t.Fatalf("CanonicalQuery: %v", err)
	}
	if a != b {
		t.Errorf("canonical query depends on input order: %q vs %q", a, b)
	}
	if a != "a=a&a=z&b=2" {
		t.Errorf("canonical query = %q, want a=a&a=z&b=2", a)
	}
}

// TestCanonicalQueryEscapesFormURLEncoded pins the trap that bites every
// non-Go implementer: a space becomes "+", not "%20", and a literal "+"
// becomes "%2B". url.ParseQuery decodes both spellings of a space on input,
// so what the caller built the string with is irrelevant — only the
// re-escaping on the way out matters.
func TestCanonicalQueryEscapesFormURLEncoded(t *testing.T) {
	for _, raw := range []string{"actor=Jane%20Smith", "actor=Jane+Smith"} {
		got, err := CanonicalQuery(raw)
		if err != nil {
			t.Fatalf("CanonicalQuery(%q): %v", raw, err)
		}
		if got != "actor=Jane+Smith" {
			t.Errorf("CanonicalQuery(%q) = %q, want actor=Jane+Smith", raw, got)
		}
	}
	got, err := CanonicalQuery("q=a%2Bb")
	if err != nil {
		t.Fatalf("CanonicalQuery: %v", err)
	}
	if got != "q=a%2Bb" {
		t.Errorf("a literal + must re-escape to %%2B, got %q", got)
	}
}

// TestCanonicalStringHashesAnAbsentBodyAsEmpty pins the one detail every GET
// on this surface depends on: nil body and empty body must hash identically,
// to the sha256 of the empty string.
func TestCanonicalStringHashesAnAbsentBodyAsEmpty(t *testing.T) {
	const emptySHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	in := SignatureInput{Method: "GET", Path: "/x", Timestamp: "1", Nonce: "n"}
	got, err := CanonicalString(in)
	if err != nil {
		t.Fatalf("CanonicalString: %v", err)
	}
	if !strings.Contains(got, emptySHA) {
		t.Errorf("a nil body must hash as the empty string, got %q", got)
	}
}
