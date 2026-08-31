package config

import (
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

// Lookup reads one environment variable. Injected so configuration can be
// tested without mutating the process environment.
type Lookup func(key string) string

type Config struct {
	Environment string
	Port        int
	BaseURL     string

	ClientID     string
	ClientSecret string
	RedirectURL  string

	SessionKey []byte
	SessionTTL time.Duration

	AdminEmails []string

	// Zitadel is the only identity provider. ZitadelProjectID doubles as the
	// expected token audience, which is why it is required: without it the
	// verifier would accept a token minted for any other project.
	ZitadelIssuer    string
	ZitadelProjectID string
	// ConsoleClientID names the client whose tokens are operators rather than
	// machines. Optional: unset costs attribution, not access.
	ConsoleClientID string

	// Backends are the secret stores this deployment enables, and
	// DefaultBackend the one a request that names none is served by.
	Backends       []secrets.Backend
	DefaultBackend secrets.Backend

	GCPProjectID string
	GCPLocations []string

	OpenBaoAddr     string
	OpenBaoMount    string
	OpenBaoK8sRole  string
	OpenBaoK8sMount string
	OpenBaoDevToken string
	AllowedOrigins  []string

	GitHubToken       string
	GitHubOwner       string
	GitHubRepo        string
	GitHubBranch      string
	GitHubValuesPath  string
	GitHubProjectPath string
}

// GitOpsEnabled reports whether the console can propose whitelist changes. The
// token is optional: without it the service runs and refuses only that call.
func (c Config) GitOpsEnabled() bool { return c.GitHubToken != "" }

func LoadFromEnv() (Config, error) { return Load(os.Getenv) }

func Load(get Lookup) (Config, error) {
	cfg := Config{
		Environment:     valueOr(get("ENVIRONMENT"), "production"),
		BaseURL:         strings.TrimRight(strings.TrimSpace(get("APP_BASE_URL")), "/"),
		ClientID:        strings.TrimSpace(get("GOOGLE_CLIENT_ID")),
		ClientSecret:    get("GOOGLE_CLIENT_SECRET"),
		OpenBaoAddr:     strings.TrimSpace(get("OPENBAO_ADDR")),
		OpenBaoMount:    valueOr(get("OPENBAO_MOUNT"), "kv"),
		OpenBaoK8sRole:  valueOr(get("OPENBAO_K8S_ROLE"), "secret-service"),
		OpenBaoK8sMount: valueOr(get("OPENBAO_K8S_MOUNT"), "kubernetes"),
		OpenBaoDevToken: get("OPENBAO_TOKEN"),

		ZitadelIssuer:    strings.TrimSpace(get("ZITADEL_ISSUER")),
		ZitadelProjectID: strings.TrimSpace(get("ZITADEL_PROJECT_ID")),
		ConsoleClientID:  strings.TrimSpace(get("CONSOLE_CLIENT_ID")),

		GitHubToken:       strings.TrimSpace(get("GITHUB_TOKEN")),
		GitHubOwner:       valueOr(get("GITHUB_OWNER"), "tesserix"),
		GitHubRepo:        valueOr(get("GITHUB_REPO"), "tesserix-k8s"),
		GitHubBranch:      valueOr(get("GITHUB_BRANCH"), "main"),
		GitHubValuesPath:  valueOr(get("GITHUB_VALUES_PATH"), "charts/thirdparty/openbao/values.yaml"),
		GitHubProjectPath: valueOr(get("GITHUB_PROJECT_PATH"), "argocd/prod/projects/security.yaml"),
	}

	port, err := strconv.Atoi(valueOr(get("PORT"), "8080"))
	if err != nil {
		return Config{}, fmt.Errorf("config: PORT is not a number: %w", err)
	}
	cfg.Port = port

	ttl, err := time.ParseDuration(valueOr(get("SESSION_TTL"), "8h"))
	if err != nil {
		return Config{}, fmt.Errorf("config: SESSION_TTL is not a duration: %w", err)
	}
	cfg.SessionTTL = ttl

	if err := cfg.loadBackends(get); err != nil {
		return Config{}, err
	}

	required := []struct{ name, value string }{
		{"APP_BASE_URL", cfg.BaseURL},
		{"GOOGLE_CLIENT_ID", cfg.ClientID},
		{"GOOGLE_CLIENT_SECRET", cfg.ClientSecret},
		{"ZITADEL_ISSUER", cfg.ZitadelIssuer},
		{"ZITADEL_PROJECT_ID", cfg.ZitadelProjectID},
	}
	if cfg.BackendEnabled(secrets.BackendOpenBao) {
		required = append(required, struct{ name, value string }{"OPENBAO_ADDR", cfg.OpenBaoAddr})
	}
	if cfg.BackendEnabled(secrets.BackendGCPSM) {
		required = append(required, struct{ name, value string }{"GCP_PROJECT_ID", cfg.GCPProjectID})
	}
	for _, required := range required {
		if required.value == "" {
			return Config{}, fmt.Errorf("config: %s is required", required.name)
		}
	}

	if !strings.HasPrefix(cfg.BaseURL, "https://") && !cfg.isDevelopment() {
		return Config{}, fmt.Errorf("config: APP_BASE_URL must be https outside development")
	}
	cfg.RedirectURL = cfg.BaseURL + "/api/auth/callback"

	key, err := decodeKey(get("SESSION_KEY"))
	if err != nil {
		return Config{}, err
	}
	cfg.SessionKey = key

	cfg.AdminEmails = splitList(get("ADMIN_EMAILS"))
	if len(cfg.AdminEmails) == 0 {
		return Config{}, fmt.Errorf("config: ADMIN_EMAILS must list at least one address")
	}

	cfg.AllowedOrigins = splitList(get("ALLOWED_ORIGINS"))
	if len(cfg.AllowedOrigins) == 0 {
		cfg.AllowedOrigins = []string{cfg.BaseURL}
	}

	return cfg, nil
}

// loadBackends reads which secret stores this deployment enables. Enabling one
// is a deployment decision: a backend absent here cannot be reached by any
// request, however it is addressed.
func (c *Config) loadBackends(get Lookup) error {
	c.GCPProjectID = strings.TrimSpace(get("GCP_PROJECT_ID"))
	c.GCPLocations = splitList(get("GCP_SM_LOCATIONS"))

	names := splitList(valueOr(get("SECRET_BACKENDS"), string(secrets.BackendOpenBao)))
	for _, name := range names {
		backend := secrets.Backend(name)
		switch backend {
		case secrets.BackendOpenBao, secrets.BackendGCPSM:
			c.Backends = append(c.Backends, backend)
		default:
			return fmt.Errorf("config: SECRET_BACKENDS names an unknown backend %q", name)
		}
	}
	if len(c.Backends) == 0 {
		return fmt.Errorf("config: SECRET_BACKENDS must name at least one backend")
	}

	c.DefaultBackend = secrets.Backend(valueOr(get("SECRET_BACKEND_DEFAULT"), string(c.Backends[0])))
	if !c.BackendEnabled(c.DefaultBackend) {
		return fmt.Errorf("config: SECRET_BACKEND_DEFAULT %q is not in SECRET_BACKENDS", c.DefaultBackend)
	}
	return nil
}

func (c Config) BackendEnabled(backend secrets.Backend) bool {
	for _, enabled := range c.Backends {
		if enabled == backend {
			return true
		}
	}
	return false
}

func (c Config) isDevelopment() bool { return c.Environment == "development" }

// IsSecure controls the Secure attribute on cookies.
func (c Config) IsSecure() bool { return strings.HasPrefix(c.BaseURL, "https://") }

func decodeKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("config: SESSION_KEY is required")
	}

	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		if key, err = base64.RawURLEncoding.DecodeString(raw); err != nil {
			return nil, fmt.Errorf("config: SESSION_KEY is not base64: %w", err)
		}
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("config: SESSION_KEY must decode to 32 bytes, got %d", len(key))
	}
	return key, nil
}

func splitList(raw string) []string {
	out := make([]string, 0, 4)
	for _, item := range strings.Split(raw, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func valueOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
