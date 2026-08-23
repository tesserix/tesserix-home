// Package handler serves the health module's one route.
package handler

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// Handler serves the module.
type Handler struct {
	svc *service.Service
	log *slog.Logger
}

func New(svc *service.Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

// Route is one of the module's paths.
//
// No `Write` field, unlike the tools module's Route: this module has no
// writes, and a bool that is false on every row is a field waiting to be
// misread as "not yet decided". A second gate can be added when a second
// route needs one.
type Route struct {
	Method  string
	Pattern string
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. Registration reads this table, and capability_test ranges over it
// and FAILS on an entry it has no case for.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/platform/health",
		handler: func(h *Handler) http.HandlerFunc { return h.health }},
}

// Routes mounts the table.
//
// One gate, `read`, and it is deliberately not parameterised per route: this
// surface renders in the console header on every page for every operator, and
// there is no route here that a session holding console entry should not see.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, route := range RouteTable {
		gate := auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapRead, h.log, route.handler(h)))
		mux.Handle(route.Method+" "+route.Pattern, gate)
	}
}

// The route takes no parameters, so the allowed set is empty and ANY query
// string is refused. There is no filtering to ask for, so `?namespace=x` is a
// caller expecting behaviour this endpoint does not have.
var noParameters = []string{}

// `ok` is the classifier's own per-row verdict, additive to the shape the
// previous release served. It is on the wire so the console does not have to
// re-derive it: a database has three ways to fail (short counts, zero
// instances, a phase that is not a healthy one) and a renderer that
// re-implements one of them marks a row fine under a summary that counts it
// bad. Optional on the client, which still has an older API to talk to.
type workloadItem struct {
	Name    string `json:"name"`
	Desired int    `json:"desired"`
	Ready   int    `json:"ready"`
	OK      bool   `json:"ok"`
}

type databaseItem struct {
	Name      string `json:"name"`
	Instances int    `json:"instances"`
	Ready     int    `json:"ready"`
	Phase     string `json:"phase"`
	OK        bool   `json:"ok"`
}

type workloadCounts struct {
	Total int            `json:"total"`
	Ready int            `json:"ready"`
	Items []workloadItem `json:"items"`
}

type databaseCounts struct {
	Total int            `json:"total"`
	Ready int            `json:"ready"`
	Items []databaseItem `json:"items"`
}

type body struct {
	State     string         `json:"state"`
	Stale     bool           `json:"stale"`
	CheckedAt string         `json:"checked_at"`
	Reason    *string        `json:"reason"`
	Workloads workloadCounts `json:"workloads"`
	Databases databaseCounts `json:"databases"`
}

// items is never nil on the wire, even for an empty snapshot: an absent
// `items` key would read as "not decided" rather than "none observed".
func workloadItems(items []domain.WorkloadItem) []workloadItem {
	out := make([]workloadItem, len(items))
	for i, item := range items {
		out[i] = workloadItem{Name: item.Name, Desired: item.Desired, Ready: item.Ready, OK: item.OK}
	}
	return out
}

func databaseItems(items []domain.DatabaseItem) []databaseItem {
	out := make([]databaseItem, len(items))
	for i, item := range items {
		out[i] = databaseItem{
			Name: item.Name, Instances: item.Instances, Ready: item.Ready, Phase: item.Phase,
			OK: item.OK,
		}
	}
	return out
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	if err := httpx.RejectUnknownParameters(r.URL.Query(), noParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	result := h.svc.Health(r.Context())

	// `reason` is a pointer so an absent reason serialises as null rather
	// than "". An empty string reads as "there is a reason and it is blank",
	// which is a different and less useful claim.
	var reason *string
	if result.Snapshot.Reason != "" {
		reason = &result.Snapshot.Reason
	}

	httpx.WriteData(w, r, http.StatusOK, body{
		State:     string(result.Snapshot.State),
		Stale:     result.Stale,
		CheckedAt: result.CheckedAt.UTC().Format(time.RFC3339),
		Reason:    reason,
		Workloads: workloadCounts{
			Total: result.Snapshot.Workloads.Total,
			Ready: result.Snapshot.Workloads.Ready,
			Items: workloadItems(result.Snapshot.WorkloadItems),
		},
		Databases: databaseCounts{
			Total: result.Snapshot.Databases.Total,
			Ready: result.Snapshot.Databases.Ready,
			Items: databaseItems(result.Snapshot.DatabaseItems),
		},
	}, h.log)
}
