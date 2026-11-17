package featureflags

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const providerOrigin = "http://helivanta-growthbook.helivanta-growthbook.svc.cluster.local:3100"
const catalogueURL = "https://raw.githubusercontent.com/tesserix/helivanta/release/prod/contracts/release-capabilities.json"
const maxResponse = 2 << 20

var errProviderUnavailable = errors.New("feature flag provider is unavailable or has unsupported configuration")
var errProviderRefused = errors.New("provider refused publication")
var errNotSent = errors.New("provider request was not dispatched")
var errUncertain = errors.New("provider mutation outcome is uncertain")

type provider struct {
	project, key, keyFile string
	client                *http.Client
}
type revision struct {
	Version int    `json:"version"`
	Comment string `json:"comment"`
}
type environment struct {
	Enabled    bool   `json:"enabled"`
	Definition string `json:"definition"`
}
type feature struct {
	Description  string                 `json:"description"`
	ID           string                 `json:"id"`
	Project      string                 `json:"project"`
	ValueType    string                 `json:"valueType"`
	DefaultValue string                 `json:"defaultValue"`
	DateUpdated  string                 `json:"dateUpdated"`
	Archived     bool                   `json:"archived"`
	Revision     revision               `json:"revision"`
	Environments map[string]environment `json:"environments"`
}
type view struct {
	Product       string    `json:"product"`
	Environment   string    `json:"environment"`
	PolicyVersion string    `json:"policy_version"`
	Revision      string    `json:"revision"`
	Flags         []flag    `json:"flags"`
	Commands      []command `json:"commands"`
	features      map[string]feature
}

func newProvider(project, key string, client *http.Client) *provider {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &provider{project: project, key: key, client: &copyClient}
}
func (p *provider) request(ctx context.Context, method, address string, body any) ([]byte, int, error) {
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			return nil, 0, errNotSent
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, address, bytes.NewReader(payload))
	if err != nil {
		return nil, 0, errNotSent
	}
	req.Header.Set("Accept", "application/json")
	if strings.HasPrefix(address, providerOrigin+"/") {
		key, keyErr := p.managementKey()
		if keyErr != nil {
			return nil, 0, errNotSent
		}
		req.Header.Set("Authorization", "Bearer "+key)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := p.client.Do(req)
	if err != nil {
		return nil, 0, errProviderUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil || len(data) > maxResponse {
		return nil, response.StatusCode, errProviderUnavailable
	}
	return data, response.StatusCode, nil
}
func (p *provider) load(ctx context.Context) (view, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	data, status, err := p.request(ctx, http.MethodGet, catalogueURL, nil)
	if err != nil || status != http.StatusOK {
		return view{}, errProviderUnavailable
	}
	c, err := parseCatalogue(data)
	if err != nil {
		return view{}, err
	}
	catalogueDigest := sha256.Sum256(data)
	data, status, err = p.request(ctx, http.MethodGet, providerOrigin+"/api/v2/features?limit=100&projectId="+url.QueryEscape(p.project), nil)
	if err != nil || status != http.StatusOK {
		return view{}, errProviderUnavailable
	}
	var result struct {
		Features []feature `json:"features"`
		HasMore  bool      `json:"hasMore"`
	}
	if json.Unmarshal(data, &result) != nil || result.HasMore || len(result.Features) > 100 {
		return view{}, errProviderUnavailable
	}
	known := map[string]bool{}
	for _, d := range c.Capabilities {
		known[d.Key] = true
	}
	enabled := map[string]bool{}
	features := map[string]feature{}
	seen := map[string]bool{}
	for _, f := range result.Features {
		if seen[f.ID] {
			return view{}, errProviderUnavailable
		}
		seen[f.ID] = true
		value, err := p.value(f)
		if err != nil {
			return view{}, err
		}
		key := strings.TrimPrefix(f.ID, flagPrefix)
		if !flagKey.MatchString(key) {
			return view{}, errProviderUnavailable
		}
		if !known[key] {
			if value {
				return view{}, errProviderUnavailable
			}
			continue
		}
		if _, ok := enabled[key]; ok {
			return view{}, errProviderUnavailable
		}
		enabled[key] = value
		features[key] = f
	}
	flags, err := evaluate(c, enabled)
	if err != nil {
		return view{}, errProviderUnavailable
	}
	encoded, err := json.Marshal(struct {
		Catalogue string
		Features  map[string]feature
	}{hex.EncodeToString(catalogueDigest[:]), features})
	if err != nil {
		return view{}, err
	}
	hash := sha256.Sum256(encoded)
	return view{Product: "helivanta", Environment: "production", PolicyVersion: c.PolicyVersion, Revision: hex.EncodeToString(hash[:]), Flags: flags, Commands: []command{}, features: features}, nil
}
func (p *provider) value(f feature) (bool, error) {
	env, ok := f.Environments["production"]
	if !strings.HasPrefix(f.ID, flagPrefix) || f.Project != p.project || f.ValueType != "boolean" || f.DefaultValue != "false" || f.Archived || !ok || !env.Enabled || f.DateUpdated == "" {
		return false, errProviderUnavailable
	}
	if _, err := time.Parse(time.RFC3339Nano, f.DateUpdated); err != nil {
		return false, errProviderUnavailable
	}
	var definition struct {
		DefaultValue *bool                        `json:"defaultValue"`
		Rules        []map[string]json.RawMessage `json:"rules"`
	}
	if json.Unmarshal([]byte(env.Definition), &definition) != nil || definition.DefaultValue == nil || *definition.DefaultValue || len(definition.Rules) > 1 {
		return false, errProviderUnavailable
	}
	for name, other := range f.Environments {
		if name == "production" || !other.Enabled {
			continue
		}
		var sdk struct {
			DefaultValue bool              `json:"defaultValue"`
			Rules        []json.RawMessage `json:"rules"`
		}
		if json.Unmarshal([]byte(other.Definition), &sdk) != nil || sdk.DefaultValue || len(sdk.Rules) > 0 {
			return false, errProviderUnavailable
		}
	}
	if len(definition.Rules) == 0 {
		return false, nil
	}
	rule := definition.Rules[0]
	for key := range rule {
		if key != "force" && key != "id" && key != "condition" {
			return false, errProviderUnavailable
		}
	}
	if condition, ok := rule["condition"]; ok && string(condition) != "null" && string(condition) != "{}" {
		return false, errProviderUnavailable
	}
	var force *bool
	if json.Unmarshal(rule["force"], &force) != nil || force == nil {
		return false, errProviderUnavailable
	}
	return *force, nil
}
func (p *provider) publish(ctx context.Context, key string, enabled bool, id, reason string) (feature, error) {
	rules := []any{}
	if enabled {
		rules = append(rules, map[string]any{"id": "tesserix-console-production", "type": "force", "value": "true", "description": "Managed in Tesserix console", "allEnvironments": false, "environments": []string{"production"}, "enabled": true})
	}
	payload := map[string]any{"rules": rules, "environments": map[string]any{"production": map[string]bool{"enabled": true}}, "comment": "Tesserix command " + id + ": " + reason}
	data, status, err := p.request(ctx, http.MethodPost, providerOrigin+"/api/v2/features/"+url.PathEscape(flagPrefix+key), payload)
	if errors.Is(err, errNotSent) {
		return feature{}, errNotSent
	}
	if err == nil && (status == 400 || status == 401 || status == 403 || status == 404 || status == 409 || status == 422) {
		return feature{}, errProviderRefused
	}
	if err != nil || status >= 500 || status < 200 || status >= 300 {
		return feature{}, errUncertain
	}
	var result struct {
		Feature       feature           `json:"feature"`
		BypassedGates []json.RawMessage `json:"bypassedGates"`
	}
	if json.Unmarshal(data, &result) != nil || len(result.BypassedGates) > 0 {
		return feature{}, errUncertain
	}
	value, err := p.value(result.Feature)
	if err != nil || value != enabled || result.Feature.ID != flagPrefix+key || !strings.HasPrefix(result.Feature.Revision.Comment, "Tesserix command "+id+": ") {
		return feature{}, errUncertain
	}
	return result.Feature, nil
}
func (p *provider) inspect(ctx context.Context, key string) (feature, error) {
	data, status, err := p.request(ctx, http.MethodGet, providerOrigin+"/api/v2/features/"+url.PathEscape(flagPrefix+key), nil)
	if err != nil || status != http.StatusOK {
		return feature{}, errProviderUnavailable
	}
	var result struct {
		Feature feature `json:"feature"`
	}
	if err = json.Unmarshal(data, &result); err != nil {
		return feature{}, errProviderUnavailable
	}
	if _, err = p.value(result.Feature); err != nil {
		return feature{}, err
	}
	if result.Feature.ID != flagPrefix+key {
		return feature{}, fmt.Errorf("%w: feature mismatch", errProviderUnavailable)
	}
	return result.Feature, nil
}

func (p *provider) create(ctx context.Context, key, id, reason string) (feature, error) {
	description := "Tesserix command " + id + ": " + reason
	data, status, err := p.request(ctx, http.MethodPost, providerOrigin+"/api/v2/features", map[string]any{
		"id": flagPrefix + key, "project": p.project, "valueType": "boolean", "defaultValue": "false",
		"description": description, "tags": []string{"helivanta", "release"}, "rules": []any{},
		"environments": map[string]any{"production": map[string]bool{"enabled": true}},
	})
	if errors.Is(err, errNotSent) {
		return feature{}, errNotSent
	}
	if err == nil && (status == 400 || status == 401 || status == 403 || status == 404 || status == 409 || status == 422) {
		return feature{}, errProviderRefused
	}
	if err != nil || status < 200 || status >= 300 {
		return feature{}, errUncertain
	}
	var result struct {
		Feature       feature           `json:"feature"`
		BypassedGates []json.RawMessage `json:"bypassedGates"`
	}
	if json.Unmarshal(data, &result) != nil || len(result.BypassedGates) > 0 {
		return feature{}, errUncertain
	}
	value, err := p.value(result.Feature)
	if err != nil || value || result.Feature.ID != flagPrefix+key || result.Feature.Description != description {
		return feature{}, errUncertain
	}
	return result.Feature, nil
}
