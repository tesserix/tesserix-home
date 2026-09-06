# Confirm a parity re-run that can cost the window (tesserix-home#594)

`RerunControl` (shipped in #591) writes permanently into the evidence #327's
Stripe write-key revocation is decided from, and its label says only "Re-run
parity check".

As of 2026-09-06 the gate is **satisfied** —
`tesserix_console_stripe_parity_window_satisfied 1`, every pair clean on every
day — so there is now a completed 7-day window to lose to one mis-click.

## The trigger condition, derived rather than assumed

`readWindowStatus` counts a day clean for a pair as
`EXISTS(outcome = 'clean') AND NOT EXISTS(outcome <> 'clean')`, and rows are
never deleted. Working through each state of TODAY:

| today, for a pair | press → clean | press → non-clean | at risk? |
|---|---|---|---|
| **clean** | stays clean | **permanently dirty** | **yes** |
| dirty | stays dirty | stays dirty | no — already lost |
| gap (no run yet) | becomes clean | becomes dirty | no — a gap is already "not clean", so this can only help or draw |

So pressing is only ever *lossy* against a day that is currently **clean**.
A gap is strictly non-losing: it is the one state where pressing is the only
way today can still become clean.

And because the gate is a conjunction over pairs, today is only contributing
to a satisfied window when **every** pair is clean today. If one pair is
already dirty today the gate is already broken for today, and the other pair's
clean day is no longer load-bearing.

**Confirm exactly when every pair's today is `clean`.** That is #580's own use
case left unobstructed: an operator whose run has gone red presses and it runs
immediately, which is the whole reason the control exists.

## Tasks

### T1 — decide, in one place, whether a press is lossy

A pure helper over `ParityWindowStatus`. Today is the LAST entry of each
pair's `days` (the query generates the series ending at today and orders by
day ascending) — this is stated where it is relied on, not left implicit.

Unknown state (`windowStatus === null`, a pair with no days) confirms rather
than runs: an extra click costs nothing and the alternative is silently
skipping the guard in exactly the case we cannot reason about.

### T2 — confirm before a lossy press

Reuse `components/kit/destructive-confirm-dialog.tsx`. Its own header records
what happened the one time a shared control was re-hand-rolled (Ruling 17 in
`lib/crm-write.ts`): a second surface's copy diverged twice inside one review
round. This is its third caller.

The copy must say the thing the button currently does not: today is clean for
every pair, a non-clean result cannot be undone, and the 7-day window
restarts.

### T3 — leave the already-lost case alone

No dialog when today is already dirty for any pair. Verified by test, because
a guard that fires on the case #580 built the control for would make the
control useless.

## Done when

- pressing with every pair clean today opens a confirmation naming the cost
- pressing when today is already dirty runs immediately, no dialog
- unknown window state confirms
- the dialog's confirm runs the same action, and cancel runs nothing

## Out of scope

Changing what a re-run records. The rows are meant to be honest — #326 states
there is no dry-run mode "because a run that did not record would not be a
run" — and this issue is about the operator knowing the price, not about
changing it.
