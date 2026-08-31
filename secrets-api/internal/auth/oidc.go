package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Google's endpoints are pinned rather than discovered so that constructing a
// Flow performs no network I/O and a Google outage cannot stop the pod starting.
const (
	googleIssuer   = "https://accounts.google.com"
	googleAuthURL  = "https://accounts.google.com/o/oauth2/v2/auth"
	googleTokenURL = "https://oauth2.googleapis.com/token"
	googleJWKSURL  = "https://www.googleapis.com/oauth2/v3/certs"
)

type FlowConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string

	HTTPClient *http.Client
}

// Claims are the identity fields this service needs from the ID token.
type Claims struct {
	Subject       string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
}

// Flow runs the authorization-code exchange against Google.
type Flow struct {
	oauth    *oauth2.Config
	verifier *oidc.IDTokenVerifier
	client   *http.Client
}

func NewFlow(ctx context.Context, cfg FlowConfig) (*Flow, error) {
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, errors.New("auth: Google client id and secret are required")
	}
	if cfg.RedirectURL == "" {
		return nil, errors.New("auth: redirect URL is required")
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = http.DefaultClient
	}

	keySet := oidc.NewRemoteKeySet(oidc.ClientContext(ctx, cfg.HTTPClient), googleJWKSURL)

	return &Flow{
		oauth: &oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.RedirectURL,
			Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
			Endpoint: oauth2.Endpoint{
				AuthURL:   googleAuthURL,
				TokenURL:  googleTokenURL,
				AuthStyle: oauth2.AuthStyleInHeader,
			},
		},
		verifier: oidc.NewVerifier(googleIssuer, keySet, &oidc.Config{ClientID: cfg.ClientID}),
		client:   cfg.HTTPClient,
	}, nil
}

func (f *Flow) AuthCodeURL(state string, p PKCE) string {
	method := p.Method
	if method == "" {
		method = "S256"
	}
	return f.oauth.AuthCodeURL(state,
		oauth2.SetAuthURLParam("code_challenge", p.Challenge),
		oauth2.SetAuthURLParam("code_challenge_method", method),
		oauth2.SetAuthURLParam("prompt", "select_account"),
	)
}

func (f *Flow) TokenURL() string { return googleTokenURL }

// Exchange trades the authorization code for an ID token and returns its
// verified claims. An unverified email is rejected: the allowlist is keyed on
// the address, so an unverified one would let an attacker claim it.
func (f *Flow) Exchange(ctx context.Context, code, verifier string) (Claims, error) {
	ctx = oidc.ClientContext(ctx, f.client)

	token, err := f.oauth.Exchange(ctx, code, oauth2.SetAuthURLParam("code_verifier", verifier))
	if err != nil {
		return Claims{}, fmt.Errorf("auth: code exchange: %w", err)
	}

	rawID, ok := token.Extra("id_token").(string)
	if !ok || rawID == "" {
		return Claims{}, errors.New("auth: token response carried no id_token")
	}

	idToken, err := f.verifier.Verify(ctx, rawID)
	if err != nil {
		return Claims{}, fmt.Errorf("auth: verify id token: %w", err)
	}

	var claims Claims
	if err := idToken.Claims(&claims); err != nil {
		return Claims{}, fmt.Errorf("auth: decode claims: %w", err)
	}
	if claims.Email == "" {
		return Claims{}, errors.New("auth: id token carried no email claim")
	}
	if !claims.EmailVerified {
		return Claims{}, fmt.Errorf("auth: email %q is not verified", claims.Email)
	}
	return claims, nil
}
