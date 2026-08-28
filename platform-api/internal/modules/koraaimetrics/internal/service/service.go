// Package service reads Kora's AI-resolution metrics and forwards them
// verbatim.
//
// # Why this does not decode Kora's response
//
// §8.9's cautionary tale: modelling a product's response as a fixed struct
// silently drops a field the modeller did not know to carry — an entity row
// modelled off Kora's foods response dropped `sublabel`, and nobody noticed
// until a users directory rendered two people identically. This endpoint's
// shape belongs to Kora (tesserix/kora#507's aiMetricsData), not to
// platform-api, and platform-api has no business re-deriving it. So Read
// returns Kora's JSON bytes unparsed, and the handler places them straight
// into the `data` field of this service's own envelope.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is Kora's own route — NOT a §3 contract endpoint. See the
// package doc on koraaimetrics for why this module, and this path, are
// Kora-specific by design.
const productPath = "/admin/ai-metrics"

// koraSlug is the one product this module ever calls. Fixed, not
// configuration: a named route built for one product has no reason to take a
// slug parameter, and taking one would just be the generic passthrough
// tesserix-home#403 rejected, with extra steps.
const koraSlug = "kora"

// ErrNotConfigured is the answer when this deployment does not federate Kora
// at all — FEDERATION_PRODUCTS omits it. Distinct from an upstream failure:
// a route that exists with nothing configured behind it is a deployment
// fact, not something Kora answered.
var ErrNotConfigured = errors.New("koraaimetrics: kora is not configured on this deployment")

// ErrUpstreamNotFound is Kora answering 404: its /v1/admin group is not
// mounted at all — in practice an empty KORA_PLATFORM_ADMIN_SECRET. Kept
// distinct from ErrUpstreamNotImplemented so an operator debugging a failure
// can tell "not mounted" from "declined" rather than the proxy collapsing
// both into one generic answer, which is exactly the trap tesserix-home#403
// calls out.
var ErrUpstreamNotFound = errors.New("koraaimetrics: kora answered 404")

// ErrUpstreamNotImplemented is Kora answering 501: the route exists but the
// endpoint declines to serve. Kept distinct from ErrUpstreamNotFound for the
// same reason.
var ErrUpstreamNotImplemented = errors.New("koraaimetrics: kora answered 501")

// Service reads Kora's ai-metrics endpoint.
type Service struct {
	fed *federation.Client
	log *slog.Logger
}

// New builds the service. log is required: a federated failure is logged
// with its unredacted cause before being reported to the caller as a
// sanitised error.
func New(fed *federation.Client, log *slog.Logger) *Service {
	return &Service{fed: fed, log: log}
}

// Read fetches Kora's ai-metrics response for the given query and returns
// Kora's JSON body unparsed.
//
// query is forwarded exactly as received — by the time it reaches here the
// handler has already narrowed it to the four parameters Kora's endpoint
// reads (from, to, page, limit) via httpx.RejectUnknownParameters. It is not
// interpreted or defaulted here: the window and paging values are part of
// the signed canonical query federation.Client computes from req.URL.
// RawQuery, and platform-api has no basis to second-guess their meaning —
// that is Kora's job, and tesserix/kora#507's parseQuery already does it.
func (s *Service) Read(ctx context.Context, op federation.Operator, query url.Values) (json.RawMessage, error) {
	path := productPath
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}

	body, err := s.fed.Get(ctx, koraSlug, path, op)
	if err != nil {
		if errors.Is(err, federation.ErrProductNotConfigured) {
			return nil, ErrNotConfigured
		}
		// 404 and 501 are different answers from Kora and must stay
		// distinguishable through this proxy — see the sentinel docs above.
		// Anything else (5xx, a status this branch does not name, or no
		// status at all — DNS, TLS, timeout) falls through to the generic
		// failure below: an outage, not a contract statement.
		if status, ok := federation.StatusOf(err); ok {
			switch status {
			case http.StatusNotFound:
				return nil, ErrUpstreamNotFound
			case http.StatusNotImplemented:
				return nil, ErrUpstreamNotImplemented
			}
		}
		s.log.Error("koraaimetrics: federated read failed", "error", err)
		return nil, fmt.Errorf("reading kora ai-metrics: %w", err)
	}
	return json.RawMessage(body), nil
}
