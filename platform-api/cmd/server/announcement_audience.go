package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// tenantCounter satisfies the announcements module's TenantSource.
//
// # Why it lives here and not in either module
//
// The announcements module needs to count tenants; the tenants module owns
// them. A module importing another module is exactly what
// internal/modules/doc.go forbids, and the stated remedy is that the consumer
// DECLARES an interface and the composition root satisfies it. This is that.
//
// It goes to federation directly rather than through the tenants module's
// service, because what it needs — statuses, and which products failed — is a
// narrower thing than the estate directory that module builds, and reusing
// that would drag its sorting, id-namespacing and pagination along for a count.
type tenantCounter struct {
	fed   *federation.Client
	reg   *federation.Registry
	limit int
}

// tenantEntityPath is the §3.4 entity endpoint for the tenant type.
//
// Duplicated from the tenants module's `productPath` rather than exported from
// it, because exporting would be the cross-module dependency this file exists
// to avoid. If the contract path ever changes, both move — and the contract is
// versioned precisely so that is a deliberate act.
const tenantEntityPath = "/admin/entities/tenants"

func (t tenantCounter) Serving() []string  { return t.reg.SlugsServing("tenants") }
func (t tenantCounter) Products() []string { return t.reg.Slugs() }
func (t tenantCounter) Limit() int         { return t.limit }

// Tenants returns each product's tenant statuses and the slugs that failed.
//
// The failure list is not decoration: a product that answered partially before
// erroring contributes rows, and counting them as a total would be a wrong
// number stated confidently. The caller uses this list to say "unavailable"
// instead.
func (t tenantCounter) Tenants(
	ctx context.Context, op announcements.Operator, slugs []string,
) (map[string][]string, []string, error) {
	if len(slugs) == 0 {
		return map[string][]string{}, nil, nil
	}

	type row struct {
		slug   string
		status string
	}

	path := fmt.Sprintf("%s?limit=%d", tenantEntityPath, t.limit)
	rows, failures := federation.FanOut(ctx, t.fed, slugs, path,
		federation.Operator{ID: op.ID, Capability: op.Capability},
		func(slug string, body []byte) ([]row, error) {
			var envelope struct {
				Data []struct {
					Status string `json:"status"`
				} `json:"data"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				return nil, fmt.Errorf("decoding %s tenants: %w", slug, err)
			}
			out := make([]row, 0, len(envelope.Data))
			for _, r := range envelope.Data {
				// The status is the PRODUCT'S own vocabulary, carried through
				// unnormalised — domain.Tenant documents why a translation
				// table here would be a second vocabulary that drifts. The
				// audience filter is matched against these strings as they
				// come.
				out = append(out, row{slug: slug, status: r.Status})
			}
			return out, nil
		})

	byProduct := make(map[string][]string, len(slugs))
	for _, r := range rows {
		byProduct[r.slug] = append(byProduct[r.slug], r.status)
	}

	failed := make([]string, 0, len(failures))
	for _, f := range failures {
		failed = append(failed, f.Product)
	}
	return byProduct, failed, nil
}
