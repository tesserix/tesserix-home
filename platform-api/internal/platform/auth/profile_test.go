package auth

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The profile a real operator's userinfo response carries. The live response
// for the token in `apps/console/lib/platform-api.ts` returns HTTP 200 with
// `name`, `email`, `preferred_username`, `given_name`, `family_name` and `sub`
// — none of which are on the access token itself.
const (
	operatorName  = "Mahesh Sangawar"
	operatorEmail = "mahesh@tesserix.app"
)

// fakeResolver records what it was asked, so a test can assert that a call did
// NOT happen. "The machine path makes no network call" is not observable from
// the returned principal, and asserting it any other way would only re-check
// the branch condition this package already owns.
type fakeResolver struct {
	mu       sync.Mutex
	calls    int
	subjects []string

	name  string
	email string
	err   error
	// block makes Resolve wait for the context, which is how the timeout is
	// exercised without the test sleeping for the real one.
	block bool
}

func (f *fakeResolver) Resolve(ctx context.Context, _, subject string) (string, string, error) {
	f.mu.Lock()
	f.calls++
	f.subjects = append(f.subjects, subject)
	f.mu.Unlock()

	if f.block {
		<-ctx.Done()
		return "", "", ctx.Err()
	}
	return f.name, f.email, f.err
}

func (f *fakeResolver) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func discardVerifier(c *Claims, resolver ProfileResolver) *Verifier {
	return NewVerifier(stubParser{claims: c}, projectID,
		WithConsoleClientID(consoleClientID),
		WithProfileResolver(resolver),
		WithLogger(discard()),
	)
}

// clock is a hand-wound time source, so cache expiry is asserted rather than
// waited for. A test that slept for profileTTL would take fifteen minutes and
// so would never be run.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

// ---- classification -----------------------------------------------------

// The #450 regression itself: this is the token the console actually presents,
// it has no email, and before the fix it was recorded as a machine.
func TestTheConsolesClientIDIdentifiesAnOperator(t *testing.T) {
	got, err := verifierFor(validClaims()).Verify(context.Background(), jwtShaped)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Kind != KindOperator {
		t.Fatalf("kind = %q, want operator — this token has no email, which is the whole of #450", got.Kind)
	}
}

// The ordering constraint: ZITADEL_CONSOLE_CLIENT_ID lands in tesserix-k8s in
// a separate PR. Until it does, this build must run — degraded, never broken.
func TestAnUnsetConsoleClientIDMakesEveryoneAService(t *testing.T) {
	for name, claims := range map[string]*Claims{
		"the operator token": validClaims(),
		"a machine token":    machineClaims(),
	} {
		t.Run(name, func(t *testing.T) {
			v := NewVerifier(stubParser{claims: claims}, projectID)

			got, err := v.Verify(context.Background(), jwtShaped)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if got.Kind != KindService {
				t.Errorf("kind = %q, want service when no console client id is configured", got.Kind)
			}
			// The empty configured value must not match the empty claim, and
			// nothing here may panic for want of a resolver.
			if got.Name != "" {
				t.Errorf("name = %q, want empty with nothing configured", got.Name)
			}
		})
	}
}

// A token with no `client_id` at all — a shape no Zitadel access token has
// today, which is exactly why it is worth pinning: "" must not match a
// configured id and must not be mistaken for the console.
func TestAnAbsentClientIDIsAService(t *testing.T) {
	c := validClaims()
	c.ClientID = ""

	got, err := verifierFor(c).Verify(context.Background(), jwtShaped)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Kind != KindService {
		t.Errorf("kind = %q, want service", got.Kind)
	}
}

// ---- resolution ---------------------------------------------------------

func TestAnOperatorsNameAndEmailComeFromUserinfo(t *testing.T) {
	resolver := &fakeResolver{name: operatorName, email: operatorEmail}

	got, err := discardVerifier(validClaims(), resolver).Verify(context.Background(), jwtShaped)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if got.Name != operatorName || got.Email != operatorEmail {
		t.Fatalf("principal = %q / %q, want %q / %q", got.Name, got.Email, operatorName, operatorEmail)
	}
	if len(resolver.subjects) != 1 || resolver.subjects[0] != operatorSubject {
		t.Errorf("resolved for %v, want the token's own subject %s", resolver.subjects, operatorSubject)
	}
}

// A machine principal has no profile, and the client_id check is the gate that
// keeps it off the network entirely.
func TestTheResolverIsNotCalledForAMachinePrincipal(t *testing.T) {
	resolver := &fakeResolver{name: operatorName, email: operatorEmail}

	got, err := discardVerifier(machineClaims(), resolver).Verify(context.Background(), jwtShaped)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if resolver.callCount() != 0 {
		t.Errorf("userinfo was called %d times for a machine caller, want 0", resolver.callCount())
	}
	if got.Name != "" || got.Email != "" {
		t.Errorf("a machine principal must carry no profile, got %q / %q", got.Name, got.Email)
	}
}

// Fail SOFT. An operator who can be authorised but not named is a worse audit
// line; refusing them because Zitadel was briefly unreachable is an outage.
func TestAUserinfoFailureDoesNotFailTheRequest(t *testing.T) {
	var logged bytes.Buffer
	resolver := &fakeResolver{err: errors.New("userinfo: connection refused")}
	v := NewVerifier(stubParser{claims: validClaims()}, projectID,
		WithConsoleClientID(consoleClientID),
		WithProfileResolver(resolver),
		WithLogger(slog.New(slog.NewTextHandler(&logged, nil))),
	)

	got, err := v.Verify(context.Background(), jwtShaped)
	if err != nil {
		t.Fatalf("a userinfo failure must never fail the request: %v", err)
	}

	if got.Kind != KindOperator {
		t.Errorf("kind = %q — a failed lookup must not change who the caller is", got.Kind)
	}
	if !got.Has(CapCRM) {
		t.Error("a failed lookup must not change what the caller may do")
	}
	if got.Name != "" || got.Email != "" {
		t.Errorf("want an unnamed principal, got %q / %q", got.Name, got.Email)
	}
	// Degraded must not be silent — the mistake #433 was.
	if !strings.Contains(logged.String(), operatorSubject) {
		t.Errorf("the warning must name the subject, got %q", logged.String())
	}
}

// The timeout is asserted with a short one, deliberately: a test that waited
// for profileTimeout would add three seconds to every run to prove a constant.
func TestASlowUserinfoIsBoundedAndStillSucceeds(t *testing.T) {
	resolver := &fakeResolver{block: true}
	v := discardVerifier(validClaims(), resolver)
	v.profileTimeout = 20 * time.Millisecond

	done := make(chan struct{})
	var got *Principal
	var err error
	go func() {
		got, err = v.Verify(context.Background(), jwtShaped)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Verify did not return — a slow issuer must not hang the request")
	}

	if err != nil {
		t.Fatalf("a timed-out lookup must not fail the request: %v", err)
	}
	if got.Name != "" || got.Kind != KindOperator {
		t.Errorf("want an unnamed operator, got %q / %q", got.Name, got.Kind)
	}
}

// The default is a real timeout, not the zero value — which context.WithTimeout
// would treat as an already-expired deadline, failing every lookup instantly.
func TestTheDefaultProfileTimeoutIsSet(t *testing.T) {
	if got := NewVerifier(stubParser{}, projectID).profileTimeout; got != profileTimeout {
		t.Fatalf("profileTimeout = %v, want %v", got, profileTimeout)
	}
}

// ---- caching ------------------------------------------------------------

// cachedVerifier wires the cache by hand so the test owns its clock.
func cachedVerifier(resolver ProfileResolver, c *clock) *Verifier {
	v := NewVerifier(stubParser{claims: validClaims()}, projectID,
		WithConsoleClientID(consoleClientID),
		WithLogger(discard()),
	)
	v.profiles = newProfileCache(resolver, c.now)
	return v
}

func TestASecondRequestForTheSameSubjectIsServedFromTheCache(t *testing.T) {
	resolver := &fakeResolver{name: operatorName, email: operatorEmail}
	c := &clock{t: time.Now()}
	v := cachedVerifier(resolver, c)

	for range 3 {
		got, err := v.Verify(context.Background(), jwtShaped)
		if err != nil {
			t.Fatalf("Verify: %v", err)
		}
		if got.Name != operatorName {
			t.Fatalf("name = %q, want %q on every request", got.Name, operatorName)
		}
	}

	if resolver.callCount() != 1 {
		t.Fatalf("userinfo called %d times, want 1 — a console session issues many requests per token", resolver.callCount())
	}
}

func TestAnExpiredCacheEntryIsResolvedAgain(t *testing.T) {
	resolver := &fakeResolver{name: operatorName, email: operatorEmail}
	c := &clock{t: time.Now()}
	v := cachedVerifier(resolver, c)

	if _, err := v.Verify(context.Background(), jwtShaped); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	c.t = c.t.Add(profileTTL + time.Second)
	if _, err := v.Verify(context.Background(), jwtShaped); err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if resolver.callCount() != 2 {
		t.Fatalf("userinfo called %d times, want 2 — a stale name must not be served forever", resolver.callCount())
	}
}

// Negative caching, and the reason it exists: without it an unreachable
// Zitadel is re-dialled on every authenticated request, turning one broken
// dependency into a per-request stall.
func TestAFailedLookupIsNotRetriedWithinTheNegativeTTL(t *testing.T) {
	resolver := &fakeResolver{err: errors.New("userinfo: connection refused")}
	c := &clock{t: time.Now()}
	v := cachedVerifier(resolver, c)

	for range 5 {
		if _, err := v.Verify(context.Background(), jwtShaped); err != nil {
			t.Fatalf("Verify: %v", err)
		}
	}
	if resolver.callCount() != 1 {
		t.Fatalf("userinfo called %d times while failing, want 1", resolver.callCount())
	}

	// And recovery is not delayed for long: the negative entry is far shorter
	// lived than a successful one.
	c.t = c.t.Add(profileNegativeTTL + time.Second)
	if _, err := v.Verify(context.Background(), jwtShaped); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if resolver.callCount() != 2 {
		t.Fatalf("userinfo called %d times after the negative TTL, want 2", resolver.callCount())
	}
	if profileNegativeTTL >= profileTTL {
		t.Error("a remembered failure must expire sooner than a remembered success")
	}
}

// The map is bounded. The key is a signed subject rather than caller-chosen
// input, but "hard to forge" is not "bounded", and this runs on a request path.
func TestTheCacheIsBounded(t *testing.T) {
	resolver := &fakeResolver{name: operatorName, email: operatorEmail}
	c := &clock{t: time.Now()}
	cache := newProfileCache(resolver, c.now)

	for i := range profileCacheMax * 2 {
		subject := "subject-" + strconv.Itoa(i)
		if _, _, err := cache.Resolve(context.Background(), jwtShaped, subject); err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if len(cache.entries) > profileCacheMax {
			t.Fatalf("cache holds %d entries after %d subjects, want at most %d",
				len(cache.entries), i+1, profileCacheMax)
		}
	}
}
