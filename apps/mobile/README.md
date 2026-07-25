# Tesserix Admin — mobile

The native iOS/Android admin console for the Tesserix platform. Expo + expo-router,
TanStack Query, and a small in-house design system (`lib/theme.ts` + `components/kit.tsx`)
ported from the tesserix-home web admin (achromatic slate, Stripe/Linear restraint).

The app talks **only** to the tesserix-home gateway (`EXPO_PUBLIC_API_BASE`) with a
bearer session — it never holds the HomeChef HMAC key or hits the Go admin API
directly. Two API surfaces:

- **Platform** — tesserix-home's own `/api/admin/*` routes (tickets, health, uptime,
  users, databases, domains, outbox, erasure, break-glass, announcements).
- **HomeChef** — the signed gateway `/api/admin/apps/homechef/gw/*` → HMAC → Go
  `/api/v1/admin/*` (orders, chefs, refunds, cancellations, delivery failures, support).

## Local dev

```bash
cd mobile
npm install
cp .env.example .env        # set EXPO_PUBLIC_API_BASE + Google client ids
npm start                   # expo dev server; press i / a for simulator
npm run ios                 # or android
npm run typecheck           # tsc --noEmit
```

For local work without Google set up, point `EXPO_PUBLIC_API_BASE` at your running
tesserix-home (`http://localhost:3002`) and set `EXPO_PUBLIC_DEV_AUTH_BYPASS=true` —
the "Continue in dev mode" button mints a mock admin session.

## Auth

- **Prod:** Google native sign-in → `POST /api/auth/mobile/google {idToken}`; the
  gateway validates the id_token + the admin allowlist and returns a bearer session.
- **Dev:** `EXPO_PUBLIC_DEV_AUTH_BYPASS=true` → `POST /api/auth/mobile/dev` mock session.

The bearer session is the same encrypted JWE the web uses as an httpOnly cookie, so
`/api/admin/*` (via middleware) and `getCurrentSession()` both accept it.

## Ship — EAS (mirrors HomeChef mobile)

Mobile is **not** a Docker image; it ships as native binaries built by Expo EAS,
separate from the web (GHCR → Kargo → ArgoCD) path.

**One-time setup:**

```bash
cd mobile
eas init                    # creates the EAS project + writes extra.eas.projectId
eas credentials             # iOS dist cert + provisioning profile; Android keystore
```

Then set `submit.production.ios.ascAppId` in `eas.json` once the App Store Connect
app exists.

**Build (CI, manual):** run the **Mobile Admin - EAS Build** workflow
(`.github/workflows/mobile-build.yml`) via *Actions → Run workflow* — pick platform,
profile (`preview` / `production`), and whether to auto-submit. Requires the
`EXPO_TOKEN` repo secret (`gh secret set EXPO_TOKEN --repo tesserix/tesserix-home`).

**Build (local):**

```bash
eas build --profile preview --platform ios      # or android / all
eas build --profile production --platform all --auto-submit
```

## CI

- **Mobile Admin - Typecheck** (`mobile-typecheck.yml`) — runs `tsc --noEmit` on any
  PR/push touching `mobile/**`. No EAS minutes.
- **Mobile Admin - EAS Build** (`mobile-build.yml`) — manual native builds.

## Structure

```
app/
  (auth)/login.tsx          Google + dev sign-in
  (tabs)/                   Overview · Apps · Platform · More
  homechef/                 HomeChef admin (orders, chefs, refunds, cancellations, …)
  platform/                 Platform ops (tickets, health, uptime, users, databases,
                            domains, outbox, erasure, break-glass, announcements)
  settings.tsx              App settings
components/kit.tsx          Design-system component vocabulary
lib/theme.ts               Palette + type scale (light/dark, OS-driven)
lib/api.ts                 axios client + hc/plat helpers
lib/auth.tsx               session context
lib/platform-hooks.ts      TanStack hooks over /api/admin/*
lib/hooks.ts               TanStack hooks over the HomeChef gateway
```
