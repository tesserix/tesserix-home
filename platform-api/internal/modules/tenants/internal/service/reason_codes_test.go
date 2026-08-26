package service

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

const mark8lyCodes = `{"data":{
	"suspend":[{"code":"fraud","label":"Fraud"},{"code":"non_payment","label":"Non-payment"}],
	"unsuspend":[{"code":"resolved","label":"Resolved"}],
	"purge":[{"code":"erasure_request","label":"Erasure request"}]
}}`

func TestReasonCodesReadsTheNamedProduct(t *testing.T) {
	srv, path, _ := lifecycleProduct(t, http.StatusOK, mark8lyCodes)
	defer srv.Close()

	got, err := lifecycleService(t, srv).ReasonCodes(context.Background(), op(), "mark8ly")
	if err != nil {
		t.Fatalf("ReasonCodes: %v", err)
	}
	if *path != "/admin/lifecycle/reason-codes" {
		t.Errorf("path = %q, want /admin/lifecycle/reason-codes", *path)
	}
	if len(got["suspend"]) != 2 || got["suspend"][0].Code != "fraud" {
		t.Errorf("suspend = %+v, want the product's own codes in its own order", got["suspend"])
	}
	if got["suspend"][0].Label != "Fraud" {
		t.Errorf("label = %q; labels are carried verbatim, never normalised here", got["suspend"][0].Label)
	}
	// Verbs beyond the two §8.8 requires are passed through, not filtered: a
	// product's set of consequential verbs is its own, and dropping `purge`
	// here would mean a second change to this file the day a purge form is
	// built.
	if len(got["purge"]) != 1 {
		t.Errorf("purge = %+v, want product-specific verbs carried through", got["purge"])
	}
}

// The one read in this module that must NOT fan out. Merging two products'
// vocabularies would offer an operator a code the owning product refuses, or
// one both accept and mean differently — which is the bug #345 is about,
// rebuilt on the server side.
func TestReasonCodesRefusesAnUnknownSource(t *testing.T) {
	srv, path, _ := lifecycleProduct(t, http.StatusOK, mark8lyCodes)
	defer srv.Close()

	_, err := lifecycleService(t, srv).ReasonCodes(context.Background(), op(), "kora")
	if !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("err = %v, want ErrUnknownSource", err)
	}
	if *path != "" {
		t.Errorf("called %q; an unknown source must be refused before any product is asked", *path)
	}
}

// An empty menu on a write that REQUIRES a code is a control that looks
// available and is not. It must reach the console as a gap, not as a form.
func TestReasonCodesRejectsAnEmptyVocabulary(t *testing.T) {
	for name, body := range map[string]string{
		"no data key":     `{}`,
		"empty data":      `{"data":{}}`,
		"empty verb list": `{"data":{"suspend":[],"unsuspend":[]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			srv, _, _ := lifecycleProduct(t, http.StatusOK, body)
			defer srv.Close()

			_, err := lifecycleService(t, srv).ReasonCodes(context.Background(), op(), "mark8ly")
			if !errors.Is(err, ErrNoReasonCodes) {
				t.Fatalf("err = %v, want ErrNoReasonCodes", err)
			}
		})
	}
}

// A verb with no codes is dropped rather than passed on empty: an absent verb
// is what the console already renders as a gap, an empty array renders as an
// empty menu.
func TestReasonCodesDropsEmptyVerbsButKeepsTheRest(t *testing.T) {
	srv, _, _ := lifecycleProduct(t, http.StatusOK,
		`{"data":{"suspend":[{"code":"fraud","label":"Fraud"}],"unsuspend":[]}}`)
	defer srv.Close()

	got, err := lifecycleService(t, srv).ReasonCodes(context.Background(), op(), "mark8ly")
	if err != nil {
		t.Fatalf("ReasonCodes: %v", err)
	}
	if _, present := got["unsuspend"]; present {
		t.Error("an empty verb was carried through; it must be absent, not empty")
	}
	if len(got["suspend"]) != 1 {
		t.Errorf("suspend = %+v, want the non-empty verb kept", got["suspend"])
	}
}

// A product that has not yet deployed §8.8 answers 404. That must surface as
// an error the console renders as a gap — never as an empty vocabulary, which
// would be indistinguishable from a product that published nothing.
func TestReasonCodesSurfacesAProductThatDoesNotServeTheRoute(t *testing.T) {
	srv, _, _ := lifecycleProduct(t, http.StatusNotFound, `{"error":"not_found"}`)
	defer srv.Close()

	_, err := lifecycleService(t, srv).ReasonCodes(context.Background(), op(), "mark8ly")
	if err == nil {
		t.Fatal("err = nil; a 404 must not read as an empty vocabulary")
	}
	if errors.Is(err, ErrNoReasonCodes) {
		t.Error("a 404 was reported as ErrNoReasonCodes; 'not deployed' and 'publishes none' are different facts")
	}
}

func TestReasonCodesRefusesWhenNoProductsAreConfigured(t *testing.T) {
	srv, _, _ := lifecycleProduct(t, http.StatusOK, mark8lyCodes)
	defer srv.Close()

	svc := New(lifecycleService(t, srv).fed, nil, testLogger())
	if _, err := svc.ReasonCodes(context.Background(), op(), "mark8ly"); !errors.Is(err, ErrNotInstrumented) {
		t.Fatalf("err = %v, want ErrNotInstrumented", err)
	}
}
