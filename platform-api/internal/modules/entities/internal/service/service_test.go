package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

func op() federation.Operator {
	return federation.Operator{ID: "op-1", Capability: "platform"}
}

func testLogger() *slog.Logger {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil))
}

// koraFoods is the shape Kora actually serves, verified live.
const koraFoods = `{"data":[
  {"id":"528ea893","type":"foods","label":"Veg kolhapuri","sublabel":"Maggi","created_at":"2026-08-22T07:16:52Z"}
],"pagination":{"page":1,"limit":2,"total":6421}}`

// svc builds a service over one product, recording the URL it was asked for.
func svc(t *testing.T, body string, types map[string][]string) (*Service, *string) {
	t.Helper()
	var asked string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.String()
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "kora", BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())
	return New(fed, types, testLogger()), &asked
}

func koraTypes() map[string][]string {
	return map[string][]string{"kora": {"users", "foods"}}
}

func TestReadReturnsTheProductsRecords(t *testing.T) {
	s, _ := svc(t, koraFoods, koraTypes())
	page, err := s.Read(context.Background(), op(), "kora", "foods", Query{Limit: 100})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(page.Data) != 1 || page.Data[0].Label != "Veg kolhapuri" {
		t.Fatalf("data = %+v", page.Data)
	}
	// Echoed, not recomputed: `total` is the product's count of matching
	// records. Substituting len(data) would claim the first page is the whole
	// result — here, 1 instead of 6421.
	// Carried through: it is what distinguishes two records sharing a label,
	// and a directory without it is ambiguous in the one way a directory must
	// not be.
	if page.Data[0].Sublabel != "Maggi" {
		t.Errorf("sublabel = %q, want it carried through", page.Data[0].Sublabel)
	}
	if page.Pagination.Total != 6421 {
		t.Errorf("total = %d, want the product's own 6421", page.Pagination.Total)
	}
}

// Two products both serving `users` return ids for entirely different people.
func TestReadNamespacesIDsAndStampsSourceAndType(t *testing.T) {
	s, _ := svc(t, koraFoods, koraTypes())
	page, _ := s.Read(context.Background(), op(), "kora", "foods", Query{Limit: 100})
	got := page.Data[0]
	if got.ID != "kora:528ea893" {
		t.Errorf("id = %q, want it namespaced", got.ID)
	}
	if got.Source != "kora" || got.Type != "foods" {
		t.Errorf("source/type = %q/%q, want stamped from what was asked", got.Source, got.Type)
	}
}

// The slug and type asked for win over anything the body claims: a product
// must not name itself into another's rows or relabel the type it was asked
// for.
func TestReadIgnoresSourceAndTypeTheProductClaims(t *testing.T) {
	body := `{"data":[{"id":"1","source":"mark8ly","type":"tenants","label":"x"}],"pagination":{"page":1,"limit":1,"total":1}}`
	s, _ := svc(t, body, koraTypes())
	page, _ := s.Read(context.Background(), op(), "kora", "foods", Query{Limit: 100})
	if page.Data[0].Source != "kora" || page.Data[0].Type != "foods" {
		t.Errorf("got %q/%q; the request wins over the body", page.Data[0].Source, page.Data[0].Type)
	}
}

// An empty q is a BROWSE, and browse is the contract's shape (§3.4, closed by
// kora#480). It must not be sent as `q=` — that filters on the empty string on
// a product that treats the param as present.
func TestReadOmitsAnEmptyQueryRatherThanSendingItBlank(t *testing.T) {
	s, asked := svc(t, koraFoods, koraTypes())
	if _, err := s.Read(context.Background(), op(), "kora", "foods", Query{Limit: 50}); err != nil {
		t.Fatalf("Read: %v", err)
	}
	if bytes.Contains([]byte(*asked), []byte("q=")) {
		t.Errorf("asked %q; an absent search must not be sent as q=", *asked)
	}
	if !bytes.Contains([]byte(*asked), []byte("limit=50")) {
		t.Errorf("asked %q, want the bound forwarded", *asked)
	}
}

func TestReadForwardsASearchVerbatim(t *testing.T) {
	s, asked := svc(t, koraFoods, koraTypes())
	if _, err := s.Read(context.Background(), op(), "kora", "foods", Query{Q: "ri", Limit: 50}); err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !bytes.Contains([]byte(*asked), []byte("q=ri")) {
		t.Errorf("asked %q, want q=ri forwarded", *asked)
	}
}

// An undeclared type reaches the product as a 404, which comes back looking
// like an outage — the operator is told the product is down when the truth is
// it never had that type.
func TestReadRefusesAnUndeclaredTypeBeforeCallingTheProduct(t *testing.T) {
	s, asked := svc(t, koraFoods, koraTypes())
	_, err := s.Read(context.Background(), op(), "kora", "tenants", Query{Limit: 100})
	if !errors.Is(err, ErrTypeNotServed) {
		t.Fatalf("err = %v, want ErrTypeNotServed", err)
	}
	if *asked != "" {
		t.Errorf("called %q; an undeclared type must be refused before any product is asked", *asked)
	}
}

// "kora has no tenants" and "there is no product called kroa" are different
// mistakes with different fixes.
func TestReadDistinguishesAnUnknownSourceFromAnUnservedType(t *testing.T) {
	s, _ := svc(t, koraFoods, koraTypes())
	_, err := s.Read(context.Background(), op(), "kroa", "foods", Query{Limit: 100})
	if !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("err = %v, want ErrUnknownSource", err)
	}
	if errors.Is(err, ErrTypeNotServed) {
		t.Error("an unknown product was reported as a product that does not serve the type")
	}
}

// A product present with an empty declaration serves no type — known, but
// nothing to ask it for.
func TestReadRefusesAProductDeclaringNoTypes(t *testing.T) {
	s, _ := svc(t, koraFoods, map[string][]string{"kora": {}})
	_, err := s.Read(context.Background(), op(), "kora", "foods", Query{Limit: 100})
	if !errors.Is(err, ErrTypeNotServed) {
		t.Fatalf("err = %v, want ErrTypeNotServed", err)
	}
}

func TestReadRefusesWhenNothingIsConfigured(t *testing.T) {
	s, _ := svc(t, koraFoods, nil)
	if _, err := s.Read(context.Background(), op(), "kora", "foods", Query{Limit: 100}); !errors.Is(err, ErrNotInstrumented) {
		t.Fatalf("err = %v, want ErrNotInstrumented", err)
	}
}

// The console iterates this; `null` is a different bug from `[]`.
func TestReadNeverReturnsNilData(t *testing.T) {
	s, _ := svc(t, `{"data":null,"pagination":{"page":1,"limit":10,"total":0}}`, koraTypes())
	page, err := s.Read(context.Background(), op(), "kora", "foods", Query{Limit: 100})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if page.Data == nil {
		t.Error("data is nil; the console iterates it")
	}
}

// mark8ly does not emit a sublabel, and that is a legitimate shape — §3.4 never
// defines the row. An absent one must not become an empty string in the JSON.
func TestReadOmitsAnAbsentSublabel(t *testing.T) {
	body := `{"data":[{"id":"t1","type":"tenants","label":"Acme"}],"pagination":{"page":1,"limit":1,"total":1}}`
	s, _ := svc(t, body, map[string][]string{"kora": {"tenants"}})
	page, err := s.Read(context.Background(), op(), "kora", "tenants", Query{Limit: 100})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if page.Data[0].Sublabel != "" {
		t.Errorf("sublabel = %q, want empty for a product that sends none", page.Data[0].Sublabel)
	}
	raw, err := json.Marshal(page.Data[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if bytes.Contains(raw, []byte("sublabel")) {
		t.Errorf("emitted %s; an absent sublabel is omitted, not sent empty", raw)
	}
}
