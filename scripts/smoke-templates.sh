#!/usr/bin/env bash
# smoke-templates.sh — round-trip smoke against the email-templates registry.
#
# What this exercises:
#   1. GET  /api/admin/email-templates/<key>?database=<db>     (read current)
#   2. PUT  /api/admin/email-templates/<key>?database=<db>     (write tweak)
#   3. GET  /api/admin/email-templates/<key>?database=<db>     (verify change)
#   4. POST /api/admin/email-templates/<key>/test-send         (send to inbox)
#   5. PUT  /api/admin/email-templates/<key>?database=<db>     (restore original)
#
# This calls user-facing API routes in tesserix-home (cookie-authed). It does
# NOT exercise mark8ly's /internal routes directly — those aren't reachable
# from outside the cluster by design. The PUT path inside tesserix-home does
# fire the cache-refresh ping internally, so a successful PUT here implicitly
# proves that part of the chain works.
#
# Usage:
#   SESSION_COOKIE='<paste from browser devtools>' \
#   ./scripts/smoke-templates.sh [--base URL] [--key welcome] [--db platform_api] [--to me@example.com]
#
# Defaults:
#   --base https://tesserix.app
#   --key  welcome              (platform-api seed key)
#   --db   platform_api         (or marketplace_api)
#   --to   $(session-derived)   (server defaults to operator's email if omitted)

set -euo pipefail

BASE="${BASE:-https://tesserix.app}"
KEY="welcome"
DB="platform_api"
TO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --key)  KEY="$2";  shift 2 ;;
    --db)   DB="$2";   shift 2 ;;
    --to)   TO="$2";   shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

if [[ -z "${SESSION_COOKIE:-}" ]]; then
  echo "ERROR: SESSION_COOKIE env var required (paste from browser devtools)." >&2
  exit 65
fi

step() { printf "\n→ %s\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; }
fail() { printf "  ✗ %s\n" "$*" >&2; exit 1; }

URL_GET="${BASE}/api/admin/email-templates/${KEY}?database=${DB}"
URL_PUT="${URL_GET}"
URL_TEST="${BASE}/api/admin/email-templates/${KEY}/test-send?database=${DB}"

# ── 1. read current ──────────────────────────────────────────────────────
step "GET ${URL_GET}"
ORIGINAL=$(curl -fsS \
  -H "Cookie: ${SESSION_COOKIE}" \
  "${URL_GET}") \
  || fail "GET failed"
ORIG_SUBJECT=$(echo "${ORIGINAL}" | python3 -c "import sys,json;print(json.load(sys.stdin)['subject'])")
ORIG_HTML=$(echo "${ORIGINAL}" | python3 -c "import sys,json;print(json.load(sys.stdin)['htmlBody'])")
ORIG_TEXT=$(echo "${ORIGINAL}" | python3 -c "import sys,json;print(json.load(sys.stdin)['textBody'])")
ORIG_VERSION=$(echo "${ORIGINAL}" | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])")
ok "current subject: ${ORIG_SUBJECT}"
ok "current version: v${ORIG_VERSION}"

# ── 2. write tweak ───────────────────────────────────────────────────────
TS=$(date -u +%Y%m%d%H%M%S)
NEW_SUBJECT="${ORIG_SUBJECT} [smoke ${TS}]"
step "PUT ${URL_PUT}  (subject → '${NEW_SUBJECT}')"
PUT_BODY=$(python3 -c "
import json,sys
print(json.dumps({
  'subject': sys.argv[1],
  'htmlBody': sys.argv[2],
  'textBody': sys.argv[3],
  'status': 'published',
}))
" "${NEW_SUBJECT}" "${ORIG_HTML}" "${ORIG_TEXT}")
SAVED=$(curl -fsS -X PUT \
  -H "Cookie: ${SESSION_COOKIE}" \
  -H "Content-Type: application/json" \
  --data-raw "${PUT_BODY}" \
  "${URL_PUT}") \
  || fail "PUT failed"
SAVED_VERSION=$(echo "${SAVED}" | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])")
ok "saved as v${SAVED_VERSION}"
[[ "${SAVED_VERSION}" -gt "${ORIG_VERSION}" ]] || fail "version did not bump"

# ── 3. verify change ─────────────────────────────────────────────────────
step "GET ${URL_GET}  (verify change)"
VERIFY=$(curl -fsS -H "Cookie: ${SESSION_COOKIE}" "${URL_GET}") || fail "GET failed"
VERIFY_SUBJECT=$(echo "${VERIFY}" | python3 -c "import sys,json;print(json.load(sys.stdin)['subject'])")
[[ "${VERIFY_SUBJECT}" == "${NEW_SUBJECT}" ]] || fail "subject didn't update"
ok "subject persisted: ${VERIFY_SUBJECT}"

# ── 4. test send ─────────────────────────────────────────────────────────
step "POST ${URL_TEST}  (real SendGrid → recipient inbox)"
TEST_BODY=$([[ -n "${TO}" ]] && echo "{\"to\":\"${TO}\",\"vars\":{}}" || echo '{"vars":{}}')
TEST_RES=$(curl -fsS -X POST \
  -H "Cookie: ${SESSION_COOKIE}" \
  -H "Content-Type: application/json" \
  --data-raw "${TEST_BODY}" \
  "${URL_TEST}") \
  || fail "test-send failed (mark8ly may not be reachable on /internal — check NetworkPolicy)"
echo "  result: ${TEST_RES}"

# ── 5. restore original ──────────────────────────────────────────────────
step "PUT ${URL_PUT}  (restore original subject)"
RESTORE_BODY=$(python3 -c "
import json,sys
print(json.dumps({
  'subject': sys.argv[1],
  'htmlBody': sys.argv[2],
  'textBody': sys.argv[3],
  'status': 'published',
}))
" "${ORIG_SUBJECT}" "${ORIG_HTML}" "${ORIG_TEXT}")
curl -fsS -X PUT \
  -H "Cookie: ${SESSION_COOKIE}" \
  -H "Content-Type: application/json" \
  --data-raw "${RESTORE_BODY}" \
  "${URL_PUT}" >/dev/null \
  || fail "restore failed (you may want to fix '${KEY}' subject manually)"
ok "subject restored"

printf "\n✅ Round-trip smoke passed.\n"
printf "   Inbox check: open the test recipient mailbox and confirm a new\n"
printf "   send arrived with subject containing '[smoke %s]' (only sent if --to was specified).\n" "${TS}"
