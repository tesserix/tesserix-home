package featureflags

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestConsoleWireFixturesComeFromTheAPIOwner(t *testing.T) {
	c := `{"version":1,"policy_version":"r1","capabilities":[{"key":"team_accounts","owner":"platform","eligible":true,"dependencies":[]},{"key":"staff_core","owner":"workforce","eligible":true,"dependencies":["team_accounts"]}]}`
	p := newProvider("prj-helivanta", "test-management-key", &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		body := `{"features":[` + providerFeature + `,` + strings.ReplaceAll(providerFeature, "team_accounts", "staff_core") + `],"hasMore":false}`
		if r.URL.Host == "raw.githubusercontent.com" {
			body = c
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})})
	v, err := p.load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)
	commands := []command{{ID: "018f8f5b-1111-7111-8111-111111111111", Actor: "operator-one", Key: "team_accounts", Enabled: false, Reason: "Reviewed release control", State: "in_doubt", Code: "OUTCOME_UNKNOWN", CreatedAt: now, UpdatedAt: now}}
	for name, value := range map[string]any{"feature-flags.json": v, "feature-flag-commands.json": commands} {
		data, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		data = append(data, '\n')
		file := filepath.Join("..", "..", "..", "..", "apps", "console", "lib", "__fixtures__", name)
		if os.Getenv("UPDATE_FEATURE_FLAG_FIXTURES") == "1" {
			if err := os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
		}
		expected, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var actualJSON, expectedJSON any
		if json.Unmarshal(data, &actualJSON) != nil || json.Unmarshal(expected, &expectedJSON) != nil {
			t.Fatalf("invalid JSON fixture %s", name)
		}
		if !reflect.DeepEqual(actualJSON, expectedJSON) {
			t.Fatalf("%s differs from the API wire contract; regenerate then verify consumers", name)
		}
	}
}
