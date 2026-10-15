package github

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) (*Client, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	c, err := New(Config{AppID: "7", InstallationID: "42", PrivateKeyPEM: string(keyPEM), Org: "tesserix", BaseURL: server.URL}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return c, key
}

// The assertion is hand-signed, so prove GitHub could verify it.
func TestTheAppAssertionIsAValidRS256Signature(t *testing.T) {
	c, key := newTestClient(t, func(http.ResponseWriter, *http.Request) {})
	jwt, err := c.assertion()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("assertion has %d parts", len(parts))
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], sig); err != nil {
		t.Fatalf("signature does not verify: %v", err)
	}
}

// A Link header naming another host must not be followed: following it would
// hand that host the installation token.
func TestAPaginationLinkOffTheAPIIsRefused(t *testing.T) {
	var foreign atomic.Bool
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		foreign.Store(true)
		_, _ = w.Write([]byte(`[]`))
	}))
	t.Cleanup(elsewhere.Close)

	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/access_tokens") {
			_, _ = w.Write([]byte(`{"token":"ghs_x","expires_at":"` + time.Now().Add(time.Hour).Format(time.RFC3339) + `"}`))
			return
		}
		w.Header().Set("Link", `<`+elsewhere.URL+`/orgs/tesserix/repos?page=2>; rel="next"`)
		_, _ = w.Write([]byte(`[]`))
	})
	if _, err := c.Repos(context.Background()); err == nil {
		t.Fatal("an off-host pagination link was accepted")
	}
	if foreign.Load() {
		t.Fatal("the foreign host was called")
	}
}
