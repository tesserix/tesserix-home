package featureflags

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const oneCatalogue = `{"version":1,"policy_version":"r1","capabilities":[{"key":"team_accounts","owner":"platform","eligible":true,"dependencies":[]}]}`
const providerFeature = `{"id":"helivanta.release.team_accounts","project":"prj-helivanta","valueType":"boolean","defaultValue":"false","dateUpdated":"2026-11-17T00:00:00Z","archived":false,"revision":{"version":1,"comment":"Initial release"},"environments":{"production":{"enabled":true,"definition":"{\"defaultValue\":false,\"rules\":[{\"force\":true}]}"}}}`

func TestProviderUsesPrivateCredentialOnlyAtItsFixedOrigin(t *testing.T) {
	calls := 0
	p := newProvider("prj-helivanta", "test-management-key", &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		calls++
		body := oneCatalogue
		if r.URL.Host == "helivanta-growthbook.helivanta-growthbook.svc.cluster.local:3100" {
			if r.Header.Get("Authorization") != "Bearer test-management-key" || r.URL.Path != "/api/v2/features" || r.URL.Query().Get("projectId") != "prj-helivanta" {
				t.Fatalf("wrong provider boundary: %s", r.URL.String())
			}
			body = `{"features":[` + providerFeature + `],"hasMore":false}`
		} else if r.URL.Host != "raw.githubusercontent.com" || r.Header.Get("Authorization") != "" {
			t.Fatal("credential disclosed outside provider")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})})
	view, err := p.load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Flags) != 1 || !view.Flags[0].Available || view.Revision == "" || calls != 2 {
		t.Fatalf("invalid snapshot %+v (%d calls)", view, calls)
	}
}

func TestProviderDriftAndIncompleteResponsesFailClosed(t *testing.T) {
	for _, body := range []string{
		`{"features":[],"hasMore":false}`,
		`{"features":[` + providerFeature + `],"hasMore":true}`,
		`{"features":[` + strings.ReplaceAll(providerFeature, "prj-helivanta", "foreign-project") + `],"hasMore":false}`,
		`{"features":[` + strings.ReplaceAll(providerFeature, `\"force\":true`, `\"force\":true,\"condition\":{\"tenant_id\":\"other\"}`) + `],"hasMore":false}`,
	} {
		p := newProvider("prj-helivanta", "test-management-key", &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
			s := body
			if r.URL.Host == "raw.githubusercontent.com" {
				s = oneCatalogue
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(s)), Header: make(http.Header)}, nil
		})})
		if _, err := p.load(context.Background()); err == nil {
			t.Fatalf("accepted provider drift: %s", body)
		}
	}
}

func TestProviderRefusalNeverLooksLikeAnUncertainTimeout(t *testing.T) {
	for _, tc := range []struct {
		status  int
		body    string
		refused bool
	}{{403, `{"message":"not allowed"}`, true}, {409, `{"message":"publication policy"}`, true}, {503, `{}`, false}, {200, `{}`, false}} {
		p := newProvider("prj-helivanta", "test-management-key", &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
			if r.Method != "POST" || !strings.Contains(r.URL.Path, "/api/v2/features/helivanta.release.team_accounts") {
				t.Fatal("wrong publication request")
			}
			data, _ := io.ReadAll(r.Body)
			if strings.Contains(string(data), "bypass") {
				t.Fatal("publication checks bypassed")
			}
			return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body)), Header: make(http.Header)}, nil
		})})
		_, err := p.publish(context.Background(), "team_accounts", false, "command-one", "Reviewed release control")
		if tc.refused {
			if !errors.Is(err, errProviderRefused) {
				t.Fatalf("refusal lost: %v", err)
			}
		} else if !errors.Is(err, errUncertain) {
			t.Fatalf("uncertain outcome was not preserved: %v", err)
		}
	}
}

func TestMissingCredentialCannotBeReportedAsAnInFlightMutation(t *testing.T) {
	called := false
	p := newProvider("prj-helivanta", "", &http.Client{Transport: transport(func(*http.Request) (*http.Response, error) { called = true; return nil, errors.New("must not send") })})
	p.keyFile = t.TempDir() + "/missing-key"
	_, err := p.publish(context.Background(), "team_accounts", false, "command-one", "Reviewed release control")
	if called || !errors.Is(err, errNotSent) {
		t.Fatalf("unsent mutation confused with timeout: called=%v err=%v", called, err)
	}
}
