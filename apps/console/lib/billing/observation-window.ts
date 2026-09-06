/**
 * #327's number: how many days of unbroken clean parity runs the observation
 * window asks for before mark8ly's Stripe write key is revoked.
 *
 * `readWindowStatus` deliberately takes the window as a parameter — "a
 * function that hard-coded it would answer 7 to someone who asked for 3" —
 * so the number belongs to a caller. It lives in this module rather than in
 * the caller because there are now TWO of them: the console's
 * `/platform/billing/catalog` surface, which renders the badge a human reads,
 * and `/api/internal/metrics`, which exports the same gate as the gauge an
 * alert fires on. Two copies would let the badge and the alert disagree about
 * whether the gate is met while each was internally consistent — and the
 * revocation is decided on that gate.
 *
 * No `server-only` and no `pg` ancestry: a plain constant, importable from a
 * route, a page, or a client component alike.
 */
export const OBSERVATION_WINDOW_DAYS = 7;
