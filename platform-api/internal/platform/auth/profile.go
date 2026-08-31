package auth

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// ProfileResolver fetches the profile claims an access token does not carry.
//
// An operator's ACCESS token has no `email` and no `name` — verified against
// the real credential `apps/console/lib/platform-api.ts` presents to this API,
// which carries `client_id`, `sub`, the org and resourceowner claims and both
// roles claims, and nothing else identifying the human. The OIDC-sanctioned way
// to recover profile claims for an access token is the userinfo endpoint, and
// it works here because the console requests the `email` and `profile` scopes
// (`apps/console/lib/auth/oidc.ts:93`).
//
// An interface for the same reason TokenParser is one: the policy in verify.go
// — who gets resolved, what a failure costs, what is cached — must be testable
// without a live Zitadel. The network call is the one part not reimplemented
// for tests.
//
// rawToken is passed rather than re-minted because userinfo authenticates with
// the caller's own token: this service holds no credential that could ask
// Zitadel about someone else, and deliberately does not acquire one.
type ProfileResolver interface {
	Resolve(ctx context.Context, rawToken, subject string) (name, email string, err error)
}

// errSubjectMismatch is userinfo answering about somebody else.
//
// Not expected to fire: the token and the answer come from the same issuer. It
// is named rather than folded into a generic failure because if it ever does
// fire, the thing to look at is Zitadel, not this cache — and because the
// consequence of ignoring it is a merchant-visible reply signed with the wrong
// person's name.
var errSubjectMismatch = errors.New("userinfo answered for a different subject")

// userinfoResolver reads profile claims from the issuer's userinfo endpoint.
//
// Built over the *oidc.Provider already constructed for token verification, so
// the endpoint comes from the discovery document fetched once at startup. The
// alternative — a second hardcoded `https://auth.tesserix.app/oidc/v1/userinfo`
// — would be a second place for the issuer to be wrong, and would keep working
// against the old host after a migration that discovery would have followed.
type userinfoResolver struct {
	provider *oidc.Provider
}

// Resolve exchanges the caller's own access token for its profile claims.
//
// The subject is checked against the one userinfo answers with. Zitadel has no
// reason to disagree with a token it signed itself, but a name and email are
// about to be written into an audit trail under `subject`, and a resolver that
// silently attributed one user's claims to another's row would produce a trail
// that is worse than the empty one it replaced.
func (r userinfoResolver) Resolve(ctx context.Context, rawToken, subject string) (string, string, error) {
	info, err := r.provider.UserInfo(ctx, oauth2.StaticTokenSource(&oauth2.Token{
		AccessToken: rawToken,
		TokenType:   "Bearer",
	}))
	if err != nil {
		return "", "", err
	}
	if info.Subject != subject {
		return "", "", errSubjectMismatch
	}

	var claims struct {
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
		Email             string `json:"email"`
	}
	if err := info.Claims(&claims); err != nil {
		return "", "", err
	}

	// `preferred_username` only when `name` is absent. Both are present on the
	// live response for a real operator, and `name` is the one a merchant
	// should see on a ticket reply — the username is a login handle.
	name := claims.Name
	if name == "" {
		name = claims.PreferredUsername
	}
	return name, claims.Email, nil
}

// The cache's lifetimes.
//
// profileTTL is long because the thing cached barely changes: a display name
// and an email address, keyed by a Zitadel subject. Fifteen minutes bounds how
// stale an audit line's attribution can be while removing userinfo from the hot
// path of a console session, which issues many requests per minute against a
// token that lives far longer than one entry.
//
// profileNegativeTTL is short, and exists for a different reason entirely: a
// FAILURE must also be remembered, or an unreachable Zitadel is re-dialled on
// every single authenticated request — turning one broken dependency into a
// per-request stall for as long as it lasts. One minute is long enough to stop
// the stampede and short enough that recovery is not noticeably delayed.
const (
	profileTTL         = 15 * time.Minute
	profileNegativeTTL = time.Minute
	// profileCacheMax bounds the map. The key is a Zitadel subject, supplied by
	// a signed token, so it cannot be forged at will — but "cannot be forged"
	// is not "bounded", and an unbounded map on a request path is a leak
	// waiting for a caller nobody predicted. The platform has operators in the
	// tens; 1024 is far above any real working set and still a fixed ceiling.
	profileCacheMax = 1024
)

// profileEntry is one memoised answer, successful or not.
type profileEntry struct {
	name    string
	email   string
	err     error
	expires time.Time
}

// profileCache memoises a ProfileResolver by subject.
//
// It wraps the resolver rather than living inside the userinfo implementation
// so that the caching policy is testable with a counting fake, and so that any
// future resolver inherits it instead of reimplementing it.
type profileCache struct {
	inner ProfileResolver
	now   func() time.Time

	mu      sync.Mutex
	entries map[string]profileEntry
}

func newProfileCache(inner ProfileResolver, now func() time.Time) *profileCache {
	return &profileCache{
		inner:   inner,
		now:     now,
		entries: make(map[string]profileEntry),
	}
}

// Resolve returns a cached answer when one is live, and otherwise calls
// through and remembers whatever comes back — including the error.
func (c *profileCache) Resolve(ctx context.Context, rawToken, subject string) (string, string, error) {
	if entry, ok := c.lookup(subject); ok {
		return entry.name, entry.email, entry.err
	}

	// Deliberately OUTSIDE the lock. Holding a mutex across a network call
	// would make one slow userinfo response block every other authenticated
	// request, which is the failure this cache exists to prevent rather than
	// cause. The cost is that two concurrent first-requests for the same
	// subject both call through; they write the same answer, so the race is
	// wasteful and not wrong.
	name, email, err := c.inner.Resolve(ctx, rawToken, subject)

	ttl := profileTTL
	if err != nil {
		ttl = profileNegativeTTL
	}
	c.store(subject, profileEntry{
		name:    name,
		email:   email,
		err:     err,
		expires: c.now().Add(ttl),
	})
	return name, email, err
}

func (c *profileCache) lookup(subject string) (profileEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, ok := c.entries[subject]
	if !ok || !c.now().Before(entry.expires) {
		return profileEntry{}, false
	}
	return entry, true
}

func (c *profileCache) store(subject string, entry profileEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.entries) >= profileCacheMax {
		c.evict()
	}
	c.entries[subject] = entry
}

// evict drops expired entries, and if that frees nothing, drops one live entry
// at random.
//
// Not an LRU. An LRU here would mean a second data structure and a recency
// write on every read, to protect a working set that is orders of magnitude
// below the ceiling — the eviction path is not expected to run at all in this
// deployment. What matters is that the map cannot grow without limit and that
// reaching the limit degrades into an extra userinfo call, never into a
// refused request. Caller must hold c.mu.
func (c *profileCache) evict() {
	now := c.now()
	for subject, entry := range c.entries {
		if !now.Before(entry.expires) {
			delete(c.entries, subject)
		}
	}
	if len(c.entries) < profileCacheMax {
		return
	}
	for subject := range c.entries {
		delete(c.entries, subject)
		return
	}
}
