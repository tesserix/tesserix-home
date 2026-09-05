package service_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/emailtemplates/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// These cover the refusals whose ORDER matters, which the HTTP tests can see
// the status of but not the reasoning behind.

func build(t *testing.T, slugs []string) *service.Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("a refused call still reached the product")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())
	return service.New(fed, slugs, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func op() federation.Operator {
	return federation.Operator{ID: "operator-1", Capability: "platform"}
}

// "No product serves this" is checked BEFORE the id is parsed. With nothing
// declared every source is unknown, and telling an operator "unknown source:
// mark8ly" when the truth is "this deployment federates no registry" sends
// them to check a slug that is spelled correctly.
func TestAnUndeclaredDeploymentSaysSoRatherThanBlamingTheSource(t *testing.T) {
	s := build(t, nil)
	_, err := s.Get(context.Background(), op(), "mark8ly:orderdoc_invoice")
	if !errors.Is(err, service.ErrNotInstrumented) {
		t.Fatalf("err = %v, want ErrNotInstrumented", err)
	}
}

func TestAnIdIsRefusedBeforeAnythingIsCalled(t *testing.T) {
	s := build(t, []string{"mark8ly"})

	for name, id := range map[string]string{
		"no source":       "orderdoc_invoice",
		"empty key":       "mark8ly:",
		"empty source":    ":orderdoc_invoice",
		"unknown source":  "kora:orderdoc_invoice",
		"path traversal":  "mark8ly:../tenants/t1/suspend",
		"space in key":    "mark8ly:orderdoc invoice",
		"query smuggling": "mark8ly:orderdoc_invoice?x=1",
	} {
		t.Run(name, func(t *testing.T) {
			// Every verb, because the guard is shared and a verb that skipped
			// it would be the one that mattered: Save and TestSend are writes.
			if _, err := s.Get(context.Background(), op(), id); err == nil {
				t.Errorf("Get(%q) was allowed", id)
			}
			if _, err := s.Save(context.Background(), op(), id, service.Upsert{}, "k"); err == nil {
				t.Errorf("Save(%q) was allowed", id)
			}
			if _, err := s.TestSend(context.Background(), op(), id,
				service.TestSendRequest{To: "x@y.z"}, "k"); err == nil {
				t.Errorf("TestSend(%q) was allowed", id)
			}
		})
	}
}
