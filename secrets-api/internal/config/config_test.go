package config_test

import (
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/config"
	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

func validEnv() map[string]string {
	return map[string]string{
		"OPENBAO_ADDR":       "http://openbao.openbao.svc:8200",
		"OPENBAO_K8S_ROLE":   "secret-service",
		"ZITADEL_ISSUER":     "https://tesserix.zitadel.cloud",
		"ZITADEL_PROJECT_ID": "123456789012345678",
		"CONSOLE_CLIENT_ID":  "987654321098765432@tesserix",
	}
}

func loadFrom(env map[string]string) (config.Config, error) {
	return config.Load(func(key string) string { return env[key] })
}

func TestLoadAcceptsACompleteEnvironment(t *testing.T) {
	cfg, err := loadFrom(validEnv())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Port != 8080 {
		t.Errorf("Port = %d, want the 8080 default", cfg.Port)
	}
}

func TestLoadRequiresEveryCredential(t *testing.T) {
	for _, key := range []string{
		"OPENBAO_ADDR",
	} {
		env := validEnv()
		delete(env, key)

		if _, err := loadFrom(env); err == nil {
			t.Errorf("Load without %s succeeded, want error", key)
		}
	}
}

// The console proposes whitelist changes to tesserix-k8s; without a token it
// still runs, and simply refuses that one operation.
func TestLoadDefaultsTheWhitelistRepository(t *testing.T) {
	cfg, err := loadFrom(validEnv())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.GitOpsEnabled() {
		t.Error("GitOpsEnabled without a token, want proposals disabled")
	}
	if cfg.GitHubOwner != "tesserix" || cfg.GitHubRepo != "tesserix-k8s" {
		t.Errorf("repository = %s/%s, want tesserix/tesserix-k8s", cfg.GitHubOwner, cfg.GitHubRepo)
	}
	if cfg.GitHubBranch != "main" {
		t.Errorf("GitHubBranch = %q, want main", cfg.GitHubBranch)
	}
	if cfg.GitHubValuesPath != "charts/thirdparty/openbao/values.yaml" {
		t.Errorf("GitHubValuesPath = %q, want the openbao chart values", cfg.GitHubValuesPath)
	}
	if cfg.GitHubProjectPath != "argocd/prod/projects/security.yaml" {
		t.Errorf("GitHubProjectPath = %q, want the security AppProject", cfg.GitHubProjectPath)
	}
}

func TestLoadEnablesProposalsWithAToken(t *testing.T) {
	env := validEnv()
	env["GITHUB_TOKEN"] = "ghp_test"
	env["GITHUB_REPO"] = "tesserix-k8s-staging"

	cfg, err := loadFrom(env)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.GitOpsEnabled() {
		t.Error("GitOpsEnabled is false despite a token")
	}
	if cfg.GitHubRepo != "tesserix-k8s-staging" {
		t.Errorf("GitHubRepo = %q, want the override", cfg.GitHubRepo)
	}
}

func TestLoadDefaultsToOpenBaoOnly(t *testing.T) {
	cfg, err := loadFrom(validEnv())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.Backends) != 1 || cfg.Backends[0] != secrets.BackendOpenBao {
		t.Fatalf("Backends = %v, want openbao alone", cfg.Backends)
	}
	if cfg.DefaultBackend != secrets.BackendOpenBao {
		t.Fatalf("DefaultBackend = %q, want openbao", cfg.DefaultBackend)
	}
}

func TestLoadEnablesGoogleSecretManager(t *testing.T) {
	env := validEnv()
	env["SECRET_BACKENDS"] = "openbao, gcpsm"
	env["SECRET_BACKEND_DEFAULT"] = "gcpsm"
	env["GCP_PROJECT_ID"] = "tesseracthub-480811"
	env["GCP_SM_LOCATIONS"] = "asia-south1, asia-southeast1"

	cfg, err := loadFrom(env)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.Backends) != 2 {
		t.Fatalf("Backends = %v, want both", cfg.Backends)
	}
	if cfg.DefaultBackend != secrets.BackendGCPSM {
		t.Fatalf("DefaultBackend = %q, want gcpsm", cfg.DefaultBackend)
	}
	if cfg.GCPProjectID != "tesseracthub-480811" || len(cfg.GCPLocations) != 2 {
		t.Fatalf("GCP settings = %q %v", cfg.GCPProjectID, cfg.GCPLocations)
	}
	if !cfg.BackendEnabled(secrets.BackendGCPSM) || !cfg.BackendEnabled(secrets.BackendOpenBao) {
		t.Fatalf("BackendEnabled disagrees with %v", cfg.Backends)
	}
}

func TestLoadRejectsAnUnknownBackend(t *testing.T) {
	env := validEnv()
	env["SECRET_BACKENDS"] = "openbao,vault-enterprise"
	if _, err := loadFrom(env); err == nil {
		t.Fatal("Load with an unknown backend succeeded, want error")
	}
}

func TestLoadRequiresAProjectWhenSecretManagerIsEnabled(t *testing.T) {
	env := validEnv()
	env["SECRET_BACKENDS"] = "gcpsm"
	if _, err := loadFrom(env); err == nil {
		t.Fatal("Load without GCP_PROJECT_ID succeeded, want error")
	}
}

func TestLoadDropsOpenBaoRequirementsWhenItIsNotEnabled(t *testing.T) {
	env := validEnv()
	env["SECRET_BACKENDS"] = "gcpsm"
	env["GCP_PROJECT_ID"] = "tesseracthub-480811"
	delete(env, "OPENBAO_ADDR")

	cfg, err := loadFrom(env)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.DefaultBackend != secrets.BackendGCPSM {
		t.Fatalf("DefaultBackend = %q, want the only enabled backend", cfg.DefaultBackend)
	}
}

func TestLoadRefusesADefaultThatIsNotEnabled(t *testing.T) {
	env := validEnv()
	env["SECRET_BACKEND_DEFAULT"] = "gcpsm"
	if _, err := loadFrom(env); err == nil {
		t.Fatal("Load with a default outside SECRET_BACKENDS succeeded, want error")
	}
}

func TestZitadelConfigIsRequired(t *testing.T) {
	for _, missing := range []string{"ZITADEL_ISSUER", "ZITADEL_PROJECT_ID"} {
		t.Run(missing, func(t *testing.T) {
			env := validEnv()
			delete(env, missing)
			if _, err := loadFrom(env); err == nil {
				t.Fatalf("Load succeeded with %s unset; it must refuse", missing)
			}
		})
	}
}

// Unset CONSOLE_CLIENT_ID is allowed and costs attribution, not access: every
// principal is then recorded as a service. Refusing to start over it would
// take the service down for a logging concern.
func TestConsoleClientIDIsOptional(t *testing.T) {
	env := validEnv()
	delete(env, "CONSOLE_CLIENT_ID")
	cfg, err := loadFrom(env)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ConsoleClientID != "" {
		t.Errorf("ConsoleClientID = %q, want empty", cfg.ConsoleClientID)
	}
}
