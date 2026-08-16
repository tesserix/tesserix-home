# Console header — design

Gives the console a header carrying operator identity, sign-out, and the notification bell, and moves the bell out of the sidebar footer where #180 put it.

## Why this exists

Two gaps, one of which is more serious than the bell's placement.

**The console cannot tell you who you are.** There is no identity display, no avatar, no sign-out — only `/auth/login` and `/auth/callback`. In an estate where seven capabilities are granted per person, where two accounts hold all of them and `iam-admin` deliberately holds none, "which account am I signed in as?" is a question the interface should answer without a trip to Zitadel. And an operator who wants to stop being signed in has no way to do it.

**Capability-gated controls are invisible without explanation.** #133 and #180 both hide controls from operators who lack the capability — the reply form, the status control. That is correct behaviour, but it means a missing button is indistinguishable from a broken page. Showing the operator which capabilities they hold turns "why is there no reply box?" into an answerable question.

The bell moving is the smaller half. It went to the sidebar footer because no header existed and building one for a single control looked like chrome for its own sake. That reasoning was right in isolation and wrong in sequence: #135 (⌘K) needs the same global home, so the frame gets built once rather than three placements invented one at a time.

## Decisions

### D1 — A bar inside the main column, not across the top

The sidebar is fixed, full-height, `hidden lg:flex`. The header sits inside the main region to its right, so the sidebar keeps its own top-to-bottom identity and the two do not compete for the top-left corner. Sticky, so identity and the bell stay reachable down a long queue.

### D2 — Right-aligned controls, left side deliberately empty

Pages already render their own `ConsolePageHeader` with the title and breadcrumbs; repeating either in the bar would give every surface two titles. The bar holds global controls only — bell, then operator menu. The left side stays empty rather than being filled, and ⌘K takes the slot beside the bell when #135 lands. No placeholder is built for it now.

### D3 — Sign-out clears the shared cookie, which signs you out everywhere

`tx_session` is scoped to `.tesserix.app`, so it is one session across the console and the web app. Clearing it from the console signs the operator out of both. That is the honest meaning of "sign out" and it matches what `apps/web/app/auth/logout/route.ts` already does; a console-only sign-out would leave the operator authenticated on a surface they thought they had left.

### D4 — Ending the Zitadel session is real but config-gated

Clearing the cookie alone leaves the IdP session intact, so clicking sign-in again re-authenticates with no prompt. On a shared machine that is a genuine surprise: the next person to click sign-in lands in the console as the previous operator, holding their capabilities.

So the route also performs RP-initiated logout at `https://auth.tesserix.app/oidc/v1/end_session` (confirmed present in the discovery document) — **but only when `ZITADEL_POST_LOGOUT_REDIRECT_URI` is set.** Zitadel rejects a `post_logout_redirect_uri` that is not registered against the application, and registering it is a change in Zitadel that this repository cannot make. Unset, the route clears the cookie and redirects locally, exactly like the web app's.

Config lands first and is verified in place, then one variable turns it on — the same pattern as the `AUTH_PROVIDER=zitadel` cutover. Until it is set, **sign-out ends the session but not the IdP session, and re-login is silent.** That is a documented limitation, not an oversight.

The cookie is cleared before the redirect either way, so the local session ends even if Zitadel refuses the request.

### D5 — Sign-out asserts `read`

The standing rule is that every verb asserts a capability, and the honest answer is the entry capability.

**The route's own check is the only gate — do not remove it.** An earlier draft of this document claimed middleware already required `read` here and that the assertion was merely belt-and-braces. That was wrong: `PUBLIC_PATHS` in `apps/console/middleware.ts` contains `/auth`, which makes every `/auth/*` path public, necessarily so, because `/auth/login` and `/auth/callback` cannot require the session they are in the business of creating. `/auth/logout` inherits that exemption. An unauthenticated request therefore reaches the handler, and the 403 it gets back comes from this assertion and nothing else.

Nobody is stranded by it: an operator holding a session but not `read` cannot sign out *here*, but `apps/web`'s logout clears the same shared cookie.

### D6 — The menu shows capabilities, because the UI already acts on them

A compact list of the capabilities the operator holds. This is status, not decoration: it is the only place that explains why a control the operator has seen before is absent today. It shows what the session carries — not what Zitadel has, which can differ until the next login, and the menu says so.

### D7 — The bell's logic does not change

Only its mount point moves, from the sidebar footer to the header. Same component, same polling, same degraded behaviour. The sidebar loses its footer entirely rather than keeping an empty bordered region.

## Not in scope

- ⌘K — #135.
- Mobile navigation. The sidebar is already `hidden lg:flex` and small screens have no nav today; the header does not attempt to solve that.
- Avatars. There is no image source for operators, and a generated monogram is decoration.
- Switching accounts, impersonation, or anything that changes who you are.
