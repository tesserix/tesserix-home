package bao_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/bao"
)

const (
	homechefAPIPolicy = "/v1/sys/policies/acl/app-homechef_homechef-api"
	homechefAPIRole   = "/v1/auth/kubernetes/role/app-homechef_homechef-api"
	denylistIndex     = "/v1/kv/metadata/_control/denylist"
)

func findRequest(t *testing.T, seen []recordedRequest, path string) recordedRequest {
	t.Helper()
	for _, r := range seen {
		if r.Path == path {
			return r
		}
	}
	t.Fatalf("no request to %q; saw %+v", path, seen)
	return recordedRequest{}
}

// OpenBao answers a role read with the role itself; the console reads its own
// write back, so a stub that returns nothing would not stand in for one.
func storedRole(serviceAccount string) map[string]any {
	return map[string]any{"data": map[string]any{"bound_service_account_names": serviceAccount}}
}

func emptyDenylist() map[string]any {
	return map[string]any{denylistIndex: map[string]any{"data": map[string]any{"keys": []string{}}}}
}

func routes(extra map[string]any) map[string]any {
	all := emptyDenylist()
	for k, v := range extra {
		all[k] = v
	}
	return all
}

func homechefGrant() bao.Grant {
	return bao.Grant{Namespace: "homechef", App: "homechef-api", ServiceAccount: "homechef-api"}
}

// Isolation is per app, not per namespace: two apps in one namespace must not
// be able to read each other's secrets.
func TestGrantScopesThePolicyToOneAppWithinTheNamespace(t *testing.T) {
	c, seen := stubBao(t, routes(map[string]any{
		homechefAPIPolicy: map[string]any{},
		homechefAPIRole:   storedRole("homechef-api"),
	}))

	if err := c.Grant(context.Background(), homechefGrant()); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	policy, _ := findRequest(t, *seen, homechefAPIPolicy).Body["policy"].(string)
	if !strings.Contains(policy, `"kv/data/homechef/homechef-api/*"`) {
		t.Errorf("policy = %q, want it scoped to the app prefix", policy)
	}
	if strings.Contains(policy, `"kv/data/homechef/*"`) {
		t.Errorf("policy = %q, want it NOT to cover the whole namespace", policy)
	}
	for _, forbidden := range []string{"create", "update", "delete", "sudo"} {
		if strings.Contains(policy, forbidden) {
			t.Errorf("policy = %q, want read-only but it grants %q", policy, forbidden)
		}
	}
}

func TestGrantBindsRoleToTheAppsServiceAccountOnly(t *testing.T) {
	c, seen := stubBao(t, routes(map[string]any{
		homechefAPIPolicy: map[string]any{},
		homechefAPIRole:   storedRole("homechef-api"),
	}))

	if err := c.Grant(context.Background(), homechefGrant()); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	body := findRequest(t, *seen, homechefAPIRole).Body
	if body["bound_service_account_names"] != "homechef-api" {
		t.Errorf("bound names = %v, want homechef-api", body["bound_service_account_names"])
	}
	if body["bound_service_account_namespaces"] != "homechef" {
		t.Errorf("bound namespaces = %v, want homechef", body["bound_service_account_namespaces"])
	}
	if body["token_policies"] != "app-homechef_homechef-api" {
		t.Errorf("token_policies = %v, want the app policy", body["token_policies"])
	}
	if body["token_ttl"] != "1h" {
		t.Errorf("token_ttl = %v, want the 1h default", body["token_ttl"])
	}
}

// "Never expires" cannot be an infinite token: it is a periodic one, which the
// workload renews for as long as the grant stands and which revoking kills.
func TestGrantWithoutAnExpiryIssuesAPeriodicToken(t *testing.T) {
	c, seen := stubBao(t, routes(map[string]any{
		homechefAPIPolicy: map[string]any{},
		homechefAPIRole:   storedRole("homechef-api"),
	}))

	g := homechefGrant()
	g.TTL = "0"
	if err := c.Grant(context.Background(), g); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	body := findRequest(t, *seen, homechefAPIRole).Body
	if body["token_period"] != "24h" {
		t.Errorf("token_period = %v, want a renewing 24h period", body["token_period"])
	}
	if body["token_ttl"] != "24h" {
		t.Errorf("token_ttl = %v, want it to match the period", body["token_ttl"])
	}
}

// Wiring a namespace usually means granting several of its workloads at once.
func TestGrantAllBindsEveryAppItIsGiven(t *testing.T) {
	const webPolicy = "/v1/sys/policies/acl/app-homechef_homechef-web"
	const webRole = "/v1/auth/kubernetes/role/app-homechef_homechef-web"
	c, seen := stubBao(t, routes(map[string]any{
		homechefAPIPolicy: map[string]any{},
		homechefAPIRole:   storedRole("homechef-api"),
		webPolicy:         map[string]any{},
		webRole:           storedRole("homechef-web"),
	}))

	granted, err := c.GrantAll(context.Background(), "homechef", "6h", []bao.AppRef{
		{Name: "homechef-api", ServiceAccount: "homechef-api"},
		{Name: "homechef-web", ServiceAccount: "homechef-web"},
	})
	if err != nil {
		t.Fatalf("GrantAll: %v", err)
	}
	if len(granted) != 2 {
		t.Fatalf("GrantAll returned %d grants, want 2", len(granted))
	}
	if granted[0].SecretPrefix != "homechef/homechef-api" {
		t.Errorf("granted[0].SecretPrefix = %q, want homechef/homechef-api", granted[0].SecretPrefix)
	}

	for _, role := range []string{homechefAPIRole, webRole} {
		if findRequest(t, *seen, role).Body["token_ttl"] != "6h" {
			t.Errorf("%s did not carry the requested 6h TTL", role)
		}
	}
}

// A rejected app must not leave the earlier ones half-wired without saying so.
func TestGrantAllReportsWhatItManagedBeforeFailing(t *testing.T) {
	c, _ := stubBao(t, routes(map[string]any{
		homechefAPIPolicy: map[string]any{},
		homechefAPIRole:   storedRole("homechef-api"),
	}))

	granted, err := c.GrantAll(context.Background(), "homechef", "1h", []bao.AppRef{
		{Name: "homechef-api", ServiceAccount: "homechef-api"},
		{Name: "bad name", ServiceAccount: "bad name"},
	})
	if err == nil {
		t.Fatal("GrantAll with an invalid app succeeded, want error")
	}
	if len(granted) != 1 || granted[0].App != "homechef-api" {
		t.Fatalf("granted = %+v, want the one app that was bound", granted)
	}
}

func TestGrantRejectsWildcardServiceAccount(t *testing.T) {
	c, seen := stubBao(t, emptyDenylist())

	for _, sa := range []string{"*", "homechef-*"} {
		g := homechefGrant()
		g.ServiceAccount = sa
		if err := c.Grant(context.Background(), g); err == nil {
			t.Errorf("Grant with ServiceAccount %q succeeded, want error", sa)
		}
	}
	for _, r := range *seen {
		if strings.Contains(r.Path, "policies") || strings.Contains(r.Path, "role") {
			t.Fatalf("wildcard grant wrote %q", r.Path)
		}
	}
}

func TestGrantRejectsMissingFieldsAndBadNames(t *testing.T) {
	c, _ := stubBao(t, emptyDenylist())

	cases := map[string]bao.Grant{
		"no namespace":       {App: "homechef-api", ServiceAccount: "homechef-api"},
		"no app":             {Namespace: "homechef", ServiceAccount: "homechef-api"},
		"no service account": {Namespace: "homechef", App: "homechef-api"},
		"bad namespace":      {Namespace: "Homechef", App: "homechef-api", ServiceAccount: "homechef-api"},
		"bad app":            {Namespace: "homechef", App: "Homechef_API", ServiceAccount: "homechef-api"},
	}

	for name, g := range cases {
		if err := c.Grant(context.Background(), g); err == nil {
			t.Errorf("Grant(%s) succeeded, want error", name)
		}
	}
}

func TestGrantRefusesADeniedNamespace(t *testing.T) {
	c, seen := stubBao(t, map[string]any{
		denylistIndex: map[string]any{"data": map[string]any{"keys": []string{"homechef/"}}},
	})

	if err := c.Grant(context.Background(), homechefGrant()); err == nil {
		t.Fatal("Grant to a denied namespace succeeded, want error")
	}
	for _, r := range *seen {
		if strings.Contains(r.Path, "policies") {
			t.Fatalf("denied grant wrote a policy: %+v", r)
		}
	}
}

func TestRevokeDeletesBothRoleAndPolicy(t *testing.T) {
	c, seen := stubBao(t, map[string]any{
		homechefAPIPolicy: map[string]any{},
		homechefAPIRole:   storedRole("homechef-api"),
	})

	if err := c.Revoke(context.Background(), "homechef", "homechef-api"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	findRequest(t, *seen, homechefAPIRole)
	findRequest(t, *seen, homechefAPIPolicy)
}

func TestGrantsListsEveryBoundApp(t *testing.T) {
	c, _ := stubBao(t, map[string]any{
		"/v1/auth/kubernetes/role": map[string]any{
			"data": map[string]any{"keys": []string{
				"app-homechef_homechef-api",
				"app-marketplace_order-service",
				"secret-service",
			}},
		},
		homechefAPIRole: map[string]any{
			"data": map[string]any{
				"bound_service_account_names":      []string{"homechef-api"},
				"bound_service_account_namespaces": []string{"homechef"},
				"token_ttl":                        "1h",
			},
		},
		"/v1/auth/kubernetes/role/app-marketplace_order-service": map[string]any{
			"data": map[string]any{
				"bound_service_account_names":      []string{"order-service"},
				"bound_service_account_namespaces": []string{"marketplace"},
				"token_ttl":                        "30m",
			},
		},
	})

	grants, err := c.Grants(context.Background())
	if err != nil {
		t.Fatalf("Grants: %v", err)
	}
	if len(grants) != 2 {
		t.Fatalf("Grants returned %d entries, want 2 — roles this service does not own must be ignored", len(grants))
	}

	if grants[0].Namespace != "homechef" || grants[0].App != "homechef-api" {
		t.Errorf("grants[0] = %+v, want homechef/homechef-api", grants[0])
	}
	if grants[1].Namespace != "marketplace" || grants[1].App != "order-service" {
		t.Errorf("grants[1] = %+v, want marketplace/order-service", grants[1])
	}
	if grants[0].SecretPrefix != "kv/homechef/homechef-api" {
		t.Errorf("grants[0].SecretPrefix = %q, want the app's KV prefix", grants[0].SecretPrefix)
	}
}

// The denylist lives in metadata, never in kv/data: this service holds no read
// capability on kv/data at all and could not read its own entries back.
func TestDenyRecordsReasonInMetadataAndRevokesExistingGrants(t *testing.T) {
	c, seen := stubBao(t, map[string]any{
		"/v1/kv/metadata/_control/denylist/homechef": map[string]any{},
		"/v1/auth/kubernetes/role": map[string]any{
			"data": map[string]any{"keys": []string{"app-homechef_homechef-api"}},
		},
		homechefAPIRole:   map[string]any{"data": map[string]any{"bound_service_account_namespaces": []string{"homechef"}}},
		homechefAPIPolicy: map[string]any{},
	})

	if err := c.Deny(context.Background(), "homechef", "leaked token", "samyak.rout@gmail.com"); err != nil {
		t.Fatalf("Deny: %v", err)
	}

	custom, ok := findRequest(t, *seen, "/v1/kv/metadata/_control/denylist/homechef").Body["custom_metadata"].(map[string]any)
	if !ok {
		t.Fatal("Deny did not record the entry as custom metadata")
	}
	if custom["reason"] != "leaked token" || custom["deniedBy"] != "samyak.rout@gmail.com" {
		t.Errorf("custom_metadata = %+v, want the reason and actor", custom)
	}

	for _, r := range *seen {
		if strings.HasPrefix(r.Path, "/v1/kv/data/") {
			t.Fatalf("Deny touched %q; the denylist must never live under kv/data", r.Path)
		}
	}
	findRequest(t, *seen, homechefAPIRole)
}

func TestAllowRemovesTheDenylistEntry(t *testing.T) {
	c, seen := stubBao(t, map[string]any{"/v1/kv/metadata/_control/denylist/homechef": map[string]any{}})

	if err := c.Allow(context.Background(), "homechef"); err != nil {
		t.Fatalf("Allow: %v", err)
	}
	findRequest(t, *seen, "/v1/kv/metadata/_control/denylist/homechef")
}

func TestDeniedListsTheDenylist(t *testing.T) {
	c, _ := stubBao(t, map[string]any{
		denylistIndex: map[string]any{"data": map[string]any{"keys": []string{"fanzone/", "homechef"}}},
		"/v1/kv/metadata/_control/denylist/homechef": map[string]any{
			"data": map[string]any{
				"custom_metadata": map[string]any{
					"reason":   "leaked token",
					"deniedBy": "samyak.rout@gmail.com",
					"deniedAt": "2026-08-12T09:30:00Z",
				},
			},
		},
		"/v1/kv/metadata/_control/denylist/fanzone": map[string]any{"data": map[string]any{}},
	})

	entries, err := c.Denied(context.Background())
	if err != nil {
		t.Fatalf("Denied: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("Denied returned %d entries, want 2", len(entries))
	}
	if entries[1].Namespace != "homechef" || entries[1].Reason != "leaked token" {
		t.Errorf("entries[1] = %+v, want the homechef entry with its reason", entries[1])
	}
}

// A grant that OpenBao accepted but did not store is worse than a refused one:
// the console would report access the app does not have. The write is read back
// before it counts.
func TestGrantFailsWhenTheRoleDoesNotReadBack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == homechefAPIRole {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"errors":[]}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(emptyDenylist()[denylistIndex])
	}))
	t.Cleanup(srv.Close)

	c, err := bao.New(bao.Config{Address: srv.URL, Mount: "kv", Token: "test-token"})
	if err != nil {
		t.Fatalf("bao.New: %v", err)
	}

	err = c.Grant(context.Background(), homechefGrant())
	if err == nil {
		t.Fatal("Grant succeeded although the role was never stored")
	}
	if !strings.Contains(err.Error(), "app-homechef_homechef-api") {
		t.Errorf("error = %v, want it to name the grant that did not persist", err)
	}
}
