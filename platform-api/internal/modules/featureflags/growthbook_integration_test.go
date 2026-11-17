//go:build growthbook_integration

package featureflags

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPinnedGrowthBookV2PublicationAndSDK(t *testing.T) {
	directory := os.Getenv("GROWTHBOOK_TEST_DIRECTORY")
	if directory == "" {
		t.Fatal("GROWTHBOOK_TEST_DIRECTORY must be set by the CI fixture setup")
	}
	var fixture struct{ Project, SDK string }
	data, err := os.ReadFile(filepath.Join(directory, "fixture.json"))
	if err != nil || json.Unmarshal(data, &fixture) != nil || fixture.Project == "" || fixture.SDK == "" {
		t.Fatal("invalid private provider fixture metadata")
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: transport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() == catalogueURL {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(oneCatalogue)), Header: make(http.Header)}, nil
		}
		if r.URL.Host != "helivanta-growthbook.helivanta-growthbook.svc.cluster.local:3100" {
			t.Fatal("unexpected provider destination")
		}
		copy := r.Clone(r.Context())
		address := *copy.URL
		address.Scheme, address.Host = "http", "127.0.0.1:3100"
		copy.URL, copy.Host = &address, address.Host
		return http.DefaultTransport.RoundTrip(copy)
	})}
	p := newProvider(fixture.Project, "", client)
	p.keyFile = filepath.Join(directory, "management-key")
	ctx := context.Background()
	v, err := p.load(ctx)
	if err != nil || len(v.Flags) != 1 || v.Flags[0].Available {
		t.Fatal("pinned provider did not return the expected disabled boolean feature")
	}
	for _, enabled := range []bool{true, false} {
		const id = "018f8f5b-1111-7111-8111-111111111111"
		published, err := p.publish(ctx, "team_accounts", enabled, id, "CI publication contract")
		if err != nil || published.Revision.Version <= v.features["team_accounts"].Revision.Version || published.Revision.Comment != "Tesserix command "+id+": CI publication contract" {
			t.Fatal("pinned GrowthBook publication/revision contract mismatch")
		}
		v, err = p.load(ctx)
		if err != nil || v.Flags[0].Available != enabled {
			t.Fatal("published setting did not reach the management read model")
		}
		confirmed := false
		for attempt := 0; attempt < 20; attempt++ {
			response, err := (&http.Client{Timeout: 5 * time.Second}).Get("http://127.0.0.1:3100/api/features/" + url.PathEscape(fixture.SDK))
			if err != nil {
				t.Fatal("SDK fixture unavailable")
			}
			var sdk struct {
				Features map[string]struct {
					DefaultValue bool `json:"defaultValue"`
					Rules        []struct {
						Force bool `json:"force"`
					} `json:"rules"`
				} `json:"features"`
			}
			err = json.NewDecoder(io.LimitReader(response.Body, maxResponse)).Decode(&sdk)
			response.Body.Close()
			if err == nil && response.StatusCode == 200 {
				if flag, ok := sdk.Features["helivanta.release.team_accounts"]; ok {
					value := flag.DefaultValue
					if len(flag.Rules) == 1 {
						value = flag.Rules[0].Force
					}
					if value == enabled {
						confirmed = true
						break
					}
				}
			}
			time.Sleep(250 * time.Millisecond)
		}
		if !confirmed {
			t.Fatal("publication did not reach SDK within the bounded wait")
		}
	}
}
