# A cooldown on TOTP attempts (tesserix-home#457)

Zitadel's `maxOtpAttempts: 10` bounds TOTP *guessing* and is verified to do so
(#445). It is also a weapon: anyone who can reach `/login` and holds an
operator's password — leaked, shared, reused — can spend ten wrong codes in a
second and put that operator in `USER_STATE_LOCKED`. The console is where you
would go to investigate an incident, so locking the operators out is a
plausible opening move rather than an annoyance.

Tuning the number cannot fix it: raising it weakens guessing protection,
lowering it makes the denial of service cheaper. It needs a different control.

## Decisions taken

**Mechanism — a cooldown that declines to forward.** After N failures for a
login name inside a window, the console refuses to call Zitadel at all until
the cooldown expires. Zitadel's counter is therefore never incremented, so the
attack cannot reach 10 however fast it runs. It self-heals, so it is not a
second lockout with the same shape as the one being fixed. It holds no server
worker, unlike a growing `sleep`.

**Key — the login name, server-sourced.** Directly bounds the rate at which a
specific operator's Zitadel counter can be incremented, which is exactly the
attack.

**NOT from the pending cookie.** `tx_login_pending` is `httpOnly` but plain
unsigned JSON — httpOnly stops page JavaScript, not a user with curl. A
forgeable login name would let an attacker throttle any operator *without even
holding their password*, which is a new denial of service in the shape of a
fix. The mapping is written server-side at the password step instead, so the
value read at the TOTP step is one the client never supplied.

## What this does and does not achieve

Zitadel resets the failure count on a successful authentication, so a cooldown
converts a guaranteed instant lockout into a race the attacker usually loses:
the victim has time to sign in and reset the count. It does not make the
lockout impossible against an operator who never signs in during the attack —
say it plainly rather than overclaim.

## Tasks

### T1 — the store (migration 0050)

Two concerns, two tables:

- `login_pending_identity(auth_request_id PK, login_name, created_at)` — the
  server-side mapping, written after a password check passes. Short-lived, and
  pruned on the same horizon as the pending cookie.
- `login_totp_failures(login_name, failed_at)` — append-only, counted within a
  window, keyed for that count.

**Hash the login name in both.** The limiter needs equality and nothing else,
so a hash gives the same behaviour while leaving the table useless to anyone
who dumps it. `lib/db/crm-erasure-hash.ts` is the existing precedent for a
keyed hash in this codebase — follow it rather than inventing a scheme.

The counter must survive a pod restart; that is why it is Postgres and not
memory.

### T2 — record the identity at the password step

In `submitCredentials`, after the password check passes and before the TOTP
outcome is returned.

### T3 — gate `submitTotp` on the cooldown

Before `addTotpCheck`, never after: the whole point is not to spend a Zitadel
attempt. On success, clear that login name's failures — mirroring Zitadel's
own reset-on-success, so an operator who fumbles twice and then succeeds
starts clean.

Thresholds: **5 failures in 15 minutes → a 15-minute cooldown.** Generous
against a fumbling operator (a genuine mis-type is one or two), and it means
reaching Zitadel's 10 takes two sustained windows rather than one second.

### T4 — say the right thing

A throttled operator is NOT locked and must not be told they are — the console
is where they would go to find out, and the wrong word there sends them to
break-glass for a problem that clears itself. The message says the attempt was
not sent, and when to try again.

### T5 — correct the comment that says this is unnecessary

`tesserix-k8s`'s `charts/apps/zitadel-bootstrap/values.yaml` ends its
`maxOtpAttempts` block with *"So the console does not need its own TOTP rate
limiting, and this is why."* #457 was split out of #445 precisely because that
conclusion creates this problem. Left standing it tells the next reader to
remove this control.

## Done when

- N failures for one login name inside the window declines the next attempt
  without calling Zitadel
- the cooldown expires on its own; nothing has to be unlocked
- a successful code clears the count
- a forged cookie cannot make the console count against another operator
- the operator-facing message never says "locked"

## Out of scope

- Changing `maxOtpAttempts` — #445 chose 10 deliberately.
- Source-IP keying — no client-IP header is read anywhere in the console today
  and which one is trustworthy through Cloudflare and Istio is unestablished.
  Worth adding later on top of this, not instead of it.
- #457 point 5 (is a lock recoverable without Zitadel console access) — a real
  question, overlapping #288's undrilled break-glass path, but it is an
  operational drill and not this change.
