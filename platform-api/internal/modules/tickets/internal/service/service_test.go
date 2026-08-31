package service

import "testing"

// What a merchant sees on a reply.
//
// The name case is the point of #450. An operator's access token carries no
// `name` and no `email`, the handler hardcoded Name to "", and displayName
// therefore fell all the way through to the fixed label — so every reply a
// human agent sent was signed "Tesserix Support" rather than with their name.
// The verifier now resolves both from userinfo, and actorOf passes them
// through.
//
// The fallbacks are asserted alongside it because they are still correct and
// still reachable: userinfo resolution fails soft, and a machine principal has
// no profile at all. author_name is NOT NULL and the console renders it
// directly, so the last case must never be an empty string.
func TestDisplayName(t *testing.T) {
	for name, tc := range map[string]struct {
		actor Actor
		want  string
	}{
		"an operator resolved from userinfo": {
			Actor{Subject: "386888878927118733", Name: "Mahesh Sangawar", Email: "mahesh@tesserix.app"},
			"Mahesh Sangawar",
		},
		"an operator whose lookup returned only an email": {
			Actor{Subject: "386888878927118733", Email: "mahesh@tesserix.app"},
			"mahesh@tesserix.app",
		},
		"a machine principal, which has neither": {
			Actor{Subject: "388414281508455697"},
			"Tesserix Support",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if got := tc.actor.displayName(); got != tc.want {
				t.Fatalf("displayName() = %q, want %q", got, tc.want)
			}
		})
	}
}
