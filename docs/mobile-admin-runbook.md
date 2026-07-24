# Mobile Admin — Prod Google-Auth Validation Runbook

Prereq: the two backend auth fixes (getCurrentSession bearer fallback + CSRF
bearer exemption) are merged to `main` and promoted to prod (Kargo → Argo).

## 1. Create Google OAuth clients (GCP / Firebase console, `app.tesserix.admin`)
- An **iOS** OAuth client → gives `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and a
  reversed-client-id (`com.googleusercontent.apps.XXXX`).
- A **Web** OAuth client → gives `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (used as the
  id_token audience for `useIdTokenAuthRequest`).

## 2. Backend config (tesserix-home prod)
- Set `GOOGLE_MOBILE_CLIENT_IDS` = the iOS + web client IDs (comma-separated) in
  the prod secret (Secret Manager → ExternalSecret in tesserix-k8s), so the
  id_token `aud` is accepted by `/api/auth/mobile/google`.
- Ensure `SESSION_ENCRYPT_KEY` and `ALLOWED_ADMIN_EMAILS` are set (already
  required for web admin). Your validating Google account must be in the allowlist.

## 3. Mobile app config
- Put the client IDs in the mobile env: `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`,
  `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`; `EXPO_PUBLIC_API_BASE=https://home.tesserix.app`;
  `EXPO_PUBLIC_DEV_AUTH_BYPASS=false`.
- For a **standalone/dev build** (not Expo Go), add the iOS reversed-client-id to
  `apps/mobile/app.json` so the OAuth redirect returns to the app:
  ```json
  "ios": {
    "bundleIdentifier": "app.tesserix.admin",
    "infoPlist": {
      "CFBundleURLTypes": [
        { "CFBundleURLSchemes": ["com.googleusercontent.apps.XXXX"] }
      ]
    }
  }
  ```
  (Expo Go demos do not need this.)

## 4. Validate
1. `cd apps/mobile && npx expo start` (or a dev build for the native URL scheme).
2. Tap "Continue with Google" → sign in with an allowlisted admin account.
3. Confirm: the dashboard (`index`), `chefs`, `orders` populate (proves the
   read path / bearer → gateway → Go API works), and an admin action
   (e.g. resolve a cancellation) succeeds (proves the write path / CSRF fix).
4. If reads 401 → the getCurrentSession fix isn't deployed. If writes 403 →
   the CSRF fix isn't deployed. If sign-in 503 → `GOOGLE_MOBILE_CLIENT_IDS`
   is unset/mismatched. If the button is disabled → mobile client IDs are empty.

## Out of this repo
The HomeChef **Go** `/api/v1/admin/*` endpoints each screen calls (and
`HOMECHEF_API_URL` / `HOMECHEF_BFF_HMAC_KEY`) live in a separate service — if a
specific screen 404/500s after auth works, verify that endpoint exists there.
