package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
)

func csrfRouter() *gin.Engine {
	r := gin.New()
	r.Use(middleware.CSRF())
	handler := func(c *gin.Context) { c.Status(http.StatusOK) }
	r.GET("/x", handler)
	r.POST("/x", handler)
	r.DELETE("/x", handler)
	return r
}

func csrfRequest(method, token, header string) *http.Request {
	req := httptest.NewRequest(method, "/x", nil)
	if token != "" {
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: token})
	}
	if header != "" {
		req.Header.Set(middleware.CSRFHeaderName, header)
	}
	return req
}

func TestCSRFAllowsSafeMethodsWithoutAToken(t *testing.T) {
	w := httptest.NewRecorder()
	csrfRouter().ServeHTTP(w, csrfRequest(http.MethodGet, "", ""))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

func TestCSRFAllowsMutationWhenCookieAndHeaderMatch(t *testing.T) {
	w := httptest.NewRecorder()
	csrfRouter().ServeHTTP(w, csrfRequest(http.MethodPost, "token-abc", "token-abc"))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

func TestCSRFRejectsMutationWithoutAMatchingToken(t *testing.T) {
	cases := map[string]*http.Request{
		"no cookie, no header": csrfRequest(http.MethodPost, "", ""),
		"cookie only":          csrfRequest(http.MethodPost, "token-abc", ""),
		"header only":          csrfRequest(http.MethodPost, "", "token-abc"),
		"mismatched":           csrfRequest(http.MethodPost, "token-abc", "token-xyz"),
		"empty pair":           csrfRequest(http.MethodDelete, "", ""),
	}

	for name, req := range cases {
		w := httptest.NewRecorder()
		csrfRouter().ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("%s: status = %d, want 403", name, w.Code)
		}
	}
}

func TestCSRFRejectsDeleteAsWellAsPost(t *testing.T) {
	w := httptest.NewRecorder()
	csrfRouter().ServeHTTP(w, csrfRequest(http.MethodDelete, "a", "b"))

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}
