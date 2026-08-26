package handler_test

import (
	"net/http"
	"testing"
)

const reasonCodesPath = "/v1/tenants/lifecycle/reason-codes"

func TestReasonCodesReturnsOneProductsVocabulary(t *testing.T) {
	a := serve(t)
	got := a.get(reasonCodesPath + "?source=" + productSlug)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}

	data := got.data(t)
	suspend, ok := data["suspend"].([]any)
	if !ok || len(suspend) != 1 {
		t.Fatalf("suspend = %v, want the product's list: %s", data["suspend"], got.raw)
	}
	entry, _ := suspend[0].(map[string]any)
	if entry["code"] != "fraud" || entry["label"] != "Fraud" {
		t.Errorf("entry = %v; code and label are carried through verbatim", entry)
	}
}

// The literal segment must win over the write routes' {id}, or this path
// resolves as a tenant called "lifecycle" and the console gets a 405 that
// looks like a routing bug in the console.
func TestReasonCodesPathIsNotSwallowedByTheTenantIDRoutes(t *testing.T) {
	a := serve(t)
	if got := a.get(reasonCodesPath + "?source=" + productSlug); got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200 — the literal route must win over /v1/tenants/{id}/...: %s",
			got.status, got.raw)
	}
}

// There is deliberately no fan-out default. Answering the estate here would
// merge vocabularies that are per-product and unequal, which is #345 rebuilt
// on the server side.
func TestReasonCodesRequiresASource(t *testing.T) {
	a := serve(t)
	got := a.get(reasonCodesPath)
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a missing source: %s", got.status, got.raw)
	}
}

func TestReasonCodesRejectsAnUnknownParameter(t *testing.T) {
	a := serve(t)
	got := a.get(reasonCodesPath + "?source=" + productSlug + "&verb=suspend")
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an unknown parameter: %s", got.status, got.raw)
	}
}

func TestReasonCodesRefusesAnUnknownSource(t *testing.T) {
	a := serve(t)
	got := a.get(reasonCodesPath + "?source=nosuchproduct")
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an unknown source: %s", got.status, got.raw)
	}
}

// 501, not an empty 200. "This deployment federates nothing" and "this product
// has no reason codes" must not arrive at the console as the same answer.
func TestReasonCodesIsNotImplementedWhenNoProductsAreConfigured(t *testing.T) {
	a := serveNoProducts(t)
	got := a.get(reasonCodesPath + "?source=" + productSlug)
	if got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", got.status, got.raw)
	}
}
