package gitops

import "testing"

// These tests exercise trailerValue, requesterTrailer and pullResource, which
// are unexported, so they live in package gitops rather than gitops_test
// alongside review_test.go.

func TestTrailerValueReadsRequester(t *testing.T) {
	body := "summary\n\nRequested by 291837.\n\nrequested-by: 291837\nwhitelist: ns/app"
	if got := trailerValue(body, requesterTrailer); got != "291837" {
		t.Fatalf("requester = %q, want %q", got, "291837")
	}
}

func TestTrailerValueAbsentIsEmpty(t *testing.T) {
	// A proposal opened before this shipped carries no trailer. Empty is the
	// only safe answer: it must match no recipient downstream.
	if got := trailerValue("summary\n\nwhitelist: ns/app", requesterTrailer); got != "" {
		t.Fatalf("requester = %q, want empty", got)
	}
}

func TestToPullRequestCarriesRequester(t *testing.T) {
	p := pullResource{Body: "s\n\nrequested-by: subject-9\nwhitelist: ns/app"}
	if got := p.toPullRequest().RequestedBy; got != "subject-9" {
		t.Fatalf("RequestedBy = %q, want %q", got, "subject-9")
	}
}

func TestParseTargetsStillWorks(t *testing.T) {
	// The generalisation must not disturb the existing trailer.
	got := parseTargets("s\n\nrequested-by: x\nwhitelist: ns/a, ns/b")
	if len(got) != 2 || got[0] != "ns/a" || got[1] != "ns/b" {
		t.Fatalf("targets = %v, want [ns/a ns/b]", got)
	}
}
