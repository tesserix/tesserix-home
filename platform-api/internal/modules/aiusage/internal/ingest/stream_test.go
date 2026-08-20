package ingest_test

import (
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/ingest"
)

func TestSubjectRoutesByProduct(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		product string
		want    string
	}{
		{name: "a labelled request", product: "marketplace", want: "ai.usage.marketplace"},
		// A dot would create a subject nobody has subscribed to, silently.
		{name: "a product with a dot in it", product: "home.chef", want: "ai.usage.home-chef"},
		{name: "a product with a wildcard in it", product: "a*b>c", want: "ai.usage.a-b-c"},
		{name: "a product with a space in it", product: "home chef", want: "ai.usage.home-chef"},
		// An unlabelled request is still spend, and still has to land somewhere.
		{name: "a request the policy did not label", product: "", want: "ai.usage.unattributed"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := ingest.Subject(ingest.Record{Product: tc.product})
			if got != tc.want {
				t.Errorf("Subject = %q, want %q", got, tc.want)
			}
			if !strings.HasPrefix(got, ingest.SubjectPrefix) {
				t.Errorf("%q is outside the stream's subject space", got)
			}
		})
	}
}
