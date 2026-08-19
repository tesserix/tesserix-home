package config_test

import (
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/config"
)

// setEnv applies the given environment for one test. t.Setenv restores it
// afterwards, which is why every case here can assume a clean slate.
func setEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for _, k := range []string{
		"PORT", "APP_ENV",
		"TESSERIX_DB_HOST", "TESSERIX_DB_PORT", "TESSERIX_DB_USER",
		"TESSERIX_DB_PASSWORD", "TESSERIX_DB_NAME", "TESSERIX_DB_SSLMODE",
		"TESSERIX_DB_MAX_CONNS",
		"PLATFORM_API_AUTH_ENABLED", "ZITADEL_ISSUER", "ZITADEL_PROJECT_ID",
	} {
		t.Setenv(k, "")
	}
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func validEnv() map[string]string {
	return map[string]string{
		"TESSERIX_DB_HOST":     "10.0.0.1",
		"TESSERIX_DB_USER":     "platform_api",
		"TESSERIX_DB_PASSWORD": "hunter2",
	}
}

func TestLoadAppliesDefaults(t *testing.T) {
	setEnv(t, validEnv())

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Port != "8080" {
		t.Errorf("want port 8080, got %s", cfg.Port)
	}
	if cfg.Database.SSLMode != "require" {
		t.Errorf("sslmode must default to require, got %q", cfg.Database.SSLMode)
	}
	// Must match the console's fallback. The estate's database is
	// tesserix_admin; defaulting to "tesserix" points local development at a
	// database that does not exist.
	if cfg.Database.Name != "tesserix_admin" {
		t.Errorf("want the estate's database tesserix_admin, got %q", cfg.Database.Name)
	}
	// ADR-003 D2a: the pool constraint is measured. A default that quietly
	// grew would undo the argument the modular monolith was chosen on.
	if cfg.Database.MaxConns != 2 {
		t.Errorf("want the console's max of 2, got %d", cfg.Database.MaxConns)
	}
	if cfg.Database.MinConns != 0 {
		t.Errorf("an idle service must hold no connections, got min %d", cfg.Database.MinConns)
	}
}

// Booting without credentials turns a startup failure into an intermittent
// runtime one, so each missing variable must be named.
func TestLoadFailsLoudlyOnMissingCredentials(t *testing.T) {
	cases := []struct {
		name    string
		unset   string
		wantVar string
	}{
		{"no host", "TESSERIX_DB_HOST", "TESSERIX_DB_HOST"},
		{"no user", "TESSERIX_DB_USER", "TESSERIX_DB_USER"},
		{"no password", "TESSERIX_DB_PASSWORD", "TESSERIX_DB_PASSWORD"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := validEnv()
			delete(e, tc.unset)
			setEnv(t, e)

			_, err := config.Load()
			if err == nil {
				t.Fatal("want an error when a credential is missing")
			}
			if !strings.Contains(err.Error(), tc.wantVar) {
				t.Errorf("error must name %s, got %q", tc.wantVar, err)
			}
		})
	}
}

func TestLoadReportsEveryMissingVariableAtOnce(t *testing.T) {
	setEnv(t, nil)

	_, err := config.Load()
	if err == nil {
		t.Fatal("want an error")
	}
	// One restart per missing variable is a miserable way to configure a
	// service.
	for _, want := range []string{"TESSERIX_DB_HOST", "TESSERIX_DB_USER", "TESSERIX_DB_PASSWORD"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error must list %s; got %q", want, err)
		}
	}
}

func TestMaxConnsOverrideIsValidated(t *testing.T) {
	for _, bad := range []string{"0", "-1", "two", "2.5"} {
		t.Run(bad, func(t *testing.T) {
			e := validEnv()
			e["TESSERIX_DB_MAX_CONNS"] = bad
			setEnv(t, e)

			if _, err := config.Load(); err == nil {
				t.Errorf("want an error for TESSERIX_DB_MAX_CONNS=%q", bad)
			}
		})
	}
}

func TestMaxConnsOverrideIsApplied(t *testing.T) {
	e := validEnv()
	e["TESSERIX_DB_MAX_CONNS"] = "6"
	setEnv(t, e)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Database.MaxConns != 6 {
		t.Errorf("want 6, got %d", cfg.Database.MaxConns)
	}
}

// The startup log prints the database config. If String() ever includes the
// password, the credential reaches Cloud Logging and this test is the only
// thing standing between the two.
func TestDatabaseStringRedactsThePassword(t *testing.T) {
	setEnv(t, validEnv())
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if strings.Contains(cfg.Database.String(), "hunter2") {
		t.Fatalf("password leaked into String(): %s", cfg.Database.String())
	}
	// Still useful, or nobody will log it and the redaction is moot.
	if !strings.Contains(cfg.Database.String(), "10.0.0.1") {
		t.Errorf("String() should still identify the host: %s", cfg.Database.String())
	}
}

func TestDSNCarriesThePassword(t *testing.T) {
	setEnv(t, validEnv())
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// The counterpart to the redaction test: DSN is the one place the secret
	// legitimately appears, and it must never be logged.
	if !strings.Contains(cfg.Database.DSN(), "password=hunter2") {
		t.Errorf("DSN must carry the password: %s", cfg.Database.DSN())
	}
}

func TestAuthIsDisabledByDefault(t *testing.T) {
	setEnv(t, validEnv())

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Deliberate and temporary. The deployed chart supplies no ZITADEL_*
	// variables, so defaulting to enabled would fail the next rollout of a
	// service that currently protects nothing.
	if cfg.Auth.Enabled {
		t.Error("auth must default to disabled while there is no module to protect")
	}
}

func TestAuthRequiresItsConfigurationWhenEnabled(t *testing.T) {
	cases := []struct {
		name    string
		extra   map[string]string
		wantVar string
	}{
		{"no issuer", map[string]string{"ZITADEL_PROJECT_ID": "p"}, "ZITADEL_ISSUER"},
		{"no project", map[string]string{"ZITADEL_ISSUER": "https://auth.test"}, "ZITADEL_PROJECT_ID"},
		{"neither", map[string]string{}, "ZITADEL_ISSUER"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := validEnv()
			e["PLATFORM_API_AUTH_ENABLED"] = "true"
			for k, v := range tc.extra {
				e[k] = v
			}
			setEnv(t, e)

			_, err := config.Load()
			if err == nil {
				t.Fatal("enabling auth without its configuration must fail at startup")
			}
			if !strings.Contains(err.Error(), tc.wantVar) {
				t.Errorf("error must name %s, got %q", tc.wantVar, err)
			}
		})
	}
}

func TestAuthLoadsWhenFullyConfigured(t *testing.T) {
	e := validEnv()
	e["PLATFORM_API_AUTH_ENABLED"] = "true"
	e["ZITADEL_ISSUER"] = "https://auth.tesserix.app"
	e["ZITADEL_PROJECT_ID"] = "386377618200461939"
	setEnv(t, e)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if !cfg.Auth.Enabled || cfg.Auth.ProjectID != "386377618200461939" {
		t.Errorf("auth not loaded: %+v", cfg.Auth)
	}
}

// Only the exact string enables it. A mistyped value must leave authentication
// in its default state rather than half-configuring it.
func TestOnlyTrueEnablesAuth(t *testing.T) {
	for _, v := range []string{"1", "yes", "True", "TRUE", "enabled", ""} {
		e := validEnv()
		e["PLATFORM_API_AUTH_ENABLED"] = v
		setEnv(t, e)

		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("PLATFORM_API_AUTH_ENABLED=%q: %v", v, err)
		}
		if cfg.Auth.Enabled {
			t.Errorf("PLATFORM_API_AUTH_ENABLED=%q must not enable auth", v)
		}
	}
}
