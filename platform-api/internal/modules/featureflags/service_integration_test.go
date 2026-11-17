//go:build integration

package featureflags

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

type providerFixture struct {
	sync.Mutex
	current      feature
	writes       int
	loseResponse bool
}

func serviceFixture(t *testing.T) (service, *providerFixture) {
	t.Helper()
	f := &providerFixture{}
	if err := json.Unmarshal([]byte(providerFeature), &f.current); err != nil {
		t.Fatal(err)
	}
	p := newProvider("prj-helivanta", "synthetic-management-credential", &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		f.Lock()
		defer f.Unlock()
		var body any
		if r.URL.String() == catalogueURL {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(oneCatalogue)), Header: make(http.Header)}, nil
		}
		if r.Method == "POST" {
			f.writes++
			var payload struct {
				ID          string            `json:"id"`
				Description string            `json:"description"`
				Rules       []json.RawMessage `json:"rules"`
				Comment     string            `json:"comment"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload.ID != "" {
				f.current = feature{ID: payload.ID, Project: "prj-helivanta", ValueType: "boolean", DefaultValue: "false", DateUpdated: "2026-11-17T00:00:00Z", Description: payload.Description, Environments: map[string]environment{}}
			}
			definition := `{"defaultValue":false}`
			if len(payload.Rules) != 0 {
				definition = `{"defaultValue":false,"rules":[{"force":true}]}`
			}
			f.current.Environments["production"] = environment{Enabled: true, Definition: definition}
			f.current.Revision.Version++
			f.current.Revision.Comment = payload.Comment
			if f.loseResponse {
				return nil, context.DeadlineExceeded
			}
			body = map[string]any{"feature": f.current}
		} else if strings.HasSuffix(r.URL.Path, "/features") {
			rows := []feature{}
			if f.current.ID != "" {
				rows = append(rows, f.current)
			}
			body = map[string]any{"features": rows, "hasMore": false}
		} else {
			body = map[string]any{"feature": f.current}
		}
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(data))), Header: make(http.Header)}, nil
	})})
	return service{provider: p, journal: journal{pool: testdb.New(t)}}, f
}

func TestServiceSuccessReplayAndNoOp(t *testing.T) {
	s, f := serviceFixture(t)
	ctx := context.Background()
	v, err := s.read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	r := change{Key: "team_accounts", Enabled: true, ExpectedRevision: v.Revision, Reason: "Reviewed release control"}
	noOp, err := s.apply(ctx, "requester", requestOne, r)
	if err != nil || noOp.State != "succeeded" || noOp.Code != "ALREADY_SET" || f.writes != 0 {
		t.Fatalf("no-op: %#v writes=%d err=%v", noOp, f.writes, err)
	}
	r.Enabled = false
	c, err := s.apply(ctx, "requester", requestTwo, r)
	if err != nil || c.State != "succeeded" || f.writes != 1 {
		t.Fatalf("publication: %#v writes=%d err=%v", c, f.writes, err)
	}
	replay, err := s.apply(ctx, "requester", requestTwo, r)
	if err != nil || replay.ID != c.ID || f.writes != 1 {
		t.Fatalf("replayed publication: %#v writes=%d err=%v", replay, f.writes, err)
	}
	r.Reason = "Different command content"
	if _, err := s.apply(ctx, "requester", requestTwo, r); !errors.Is(err, errKeyReused) {
		t.Fatalf("changed replay accepted: %v", err)
	}
}

func TestUncertainDeliveryOnlySettlesFromAttributableProviderEvidence(t *testing.T) {
	s, f := serviceFixture(t)
	ctx := context.Background()
	v, err := s.read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f.loseResponse = true
	r := change{Key: "team_accounts", Enabled: false, ExpectedRevision: v.Revision, Reason: "Reviewed release control"}
	c, err := s.apply(ctx, "requester", requestOne, r)
	if err != nil || c.State != "in_doubt" || f.writes != 1 {
		t.Fatalf("unknown delivery: %#v writes=%d err=%v", c, f.writes, err)
	}
	if replay, err := s.recover(ctx, "requester", c.ID, true); err != nil || replay.State != "in_doubt" || f.writes != 1 {
		t.Fatalf("unsafe recovery: %#v %v", replay, err)
	}
	f.current.Revision.Comment = "Unrelated external edit"
	v, err = s.read(ctx)
	if err != nil || v.Commands[0].State != "in_doubt" {
		t.Fatalf("unattributed publication settled: %#v %v", v.Commands, err)
	}
	f.current.Revision.Comment = "Tesserix command " + c.ID + ": " + c.Reason
	v, err = s.read(ctx)
	if err != nil || v.Commands[0].State != "succeeded" || v.Flags[0].Available || f.writes != 1 {
		t.Fatalf("read-only reconciliation: %#v writes=%d err=%v", v, f.writes, err)
	}
}

func TestQueuedRecoveryUsesOriginalActorAndReleaseRevision(t *testing.T) {
	s, f := serviceFixture(t)
	ctx := context.Background()
	v, err := s.read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	r := change{Key: "team_accounts", Enabled: false, ExpectedRevision: v.Revision, Reason: "Reviewed release control"}
	c, _, err := s.journal.reserve(ctx, "requester", requestOne, r, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.recover(ctx, "other-operator", c.ID, true); err == nil || f.writes != 0 {
		t.Fatal("another actor resumed request")
	}
	// A provider edit after reservation invalidates the original confirmation.
	f.current.Revision.Version++
	result, err := s.recover(ctx, "requester", c.ID, true)
	if err != nil || result.State != "failed" || result.Code != "STALE_FLAGS" || f.writes != 0 {
		t.Fatalf("stale queued request published: %#v %v", result, err)
	}
}

func TestCreateDisabledDefinitionUsesJournalAndReconcilesLostResponse(t *testing.T) {
	s, f := serviceFixture(t)
	f.current = feature{}
	v, err := s.read(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if v.Flags[0].Provisioned {
		t.Fatal("missing definition hidden")
	}
	f.loseResponse = true
	r := change{Key: "team_accounts", Enabled: false, ExpectedRevision: v.Revision, Reason: "Provision reviewed definition disabled"}
	c, err := s.apply(t.Context(), "operator-one", "018f8f5b-3333-7333-8333-333333333333", r)
	if err != nil || c.State != "in_doubt" || f.writes != 1 {
		t.Fatalf("create timeout: %+v %v", c, err)
	}
	f.loseResponse = false
	v, err = s.read(t.Context())
	if err != nil || !v.Flags[0].Provisioned || v.Flags[0].Enabled || v.Commands[0].State != "succeeded" {
		t.Fatalf("create evidence not reconciled: %+v %v", v, err)
	}
	replay, err := s.apply(t.Context(), "operator-one", "018f8f5b-3333-7333-8333-333333333333", r)
	if err != nil || replay.ID != c.ID || f.writes != 1 {
		t.Fatalf("replayed create wrote again: %+v %v", replay, err)
	}
}
