/**
 * Validates a secret path an operator is about to CREATE, before the console
 * ever calls the API.
 *
 * This is a mirror of `secrets-api/internal/secrets/path.go`
 * (`CleanSecretPath`, `validateSegment`, `namespacePattern`,
 * `maxSecretPathLen`, `ParseSecretRef`), plus — for the `gcpsm` store only —
 * `segmentPattern` and `pathSeparator` from `secrets-api/internal/gcpsm/gcpsm.go`
 * (the character set Google Secret Manager accepts for a secret id, and the
 * `--` a path's segments are joined with to form one). The API re-runs every
 * one of these checks itself and remains the actual control; duplicating
 * them here exists only so an operator learns which specific rule they broke
 * — and on which segment — before a network round trip, rather than after
 * submitting. If either Go file's rules change, this file must change with
 * it, and vice versa.
 */

import type { SecretStore } from "@/lib/secrets";

/** Mirrors `maxSecretPathLen` in path.go. */
const MAX_SECRET_PATH_LEN = 512;

/**
 * Mirrors `namespacePattern` in path.go — an RFC1123 DNS label: lowercase
 * alphanumeric, may contain internal hyphens, must start and end with an
 * alphanumeric character, at most 63 characters. Used for both the
 * namespace (segment 0) and the app (segment 1) via `ParseSecretRef`.
 */
const NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Mirrors `segmentPattern` in gcpsm.go — the character set Google Secret
 * Manager accepts for a secret id: letters, digits, hyphen, underscore.
 * `SecretID` checks every segment of the path against this, not just the
 * namespace and app, so this validator does the same.
 */
const GCPSM_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Mirrors `pathSeparator` in gcpsm.go. `SecretID` joins a path's segments
 * with `--` to form the Secret Manager id, and `PathFromSecretID` reverses
 * that by splitting on `--` — so a segment that itself contains `--` would
 * not round-trip back to the original path. This is not a Google naming
 * restriction and not a style convention; it exists solely so the encoding
 * stays reversible.
 */
const GCPSM_PATH_SEPARATOR = "--";

export interface SecretPathProblem {
  readonly message: string;
}

export type SecretPathValidation = { ok: true; cleaned: string } | { ok: false; message: string };

function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  // Mirrors validateSegment's `r < 0x20 || r == 0x7f` in path.go.
  return code < 0x20 || code === 0x7f;
}

/**
 * Mirrors `CleanSecretPath`: trim, reject an oversized or backslash-bearing
 * path, then split on `/`, dropping empty segments and rejecting `.`, `..`,
 * percent-encoded segments, and segments with control characters.
 */
function cleanSecretPath(path: string): { ok: true; segments: readonly string[] } | { ok: false; message: string } {
  const trimmed = path.trim();
  if (trimmed.length > MAX_SECRET_PATH_LEN) {
    return { ok: false, message: `Path may not exceed ${MAX_SECRET_PATH_LEN} characters.` };
  }
  if (trimmed.includes("\\")) {
    return { ok: false, message: "Path may not contain a backslash." };
  }

  const segments: string[] = [];
  for (const seg of trimmed.split("/")) {
    if (seg === "") continue;
    if (seg === "." || seg === "..") {
      return { ok: false, message: `Path may not contain "${seg}".` };
    }
    if (seg.includes("%")) {
      return { ok: false, message: `Segment "${seg}" may not be percent-encoded.` };
    }
    if (Array.from(seg).some(isControlChar)) {
      return { ok: false, message: `Segment "${seg}" contains a control character.` };
    }
    segments.push(seg);
  }
  if (segments.length === 0) {
    return { ok: false, message: "Path is empty." };
  }
  return { ok: true, segments };
}

/**
 * Validates a path an operator has typed for a new secret. Cleans it first
 * (see `cleanSecretPath`), then requires at least the `<namespace>/<app>/
 * <name>` shape `ParseSecretRef` demands, checking the namespace and app
 * segments against the DNS-label pattern — and, only for `gcpsm`, every
 * segment against the narrower character set Google Secret Manager accepts.
 *
 * Never throws: the form renders `message` inline as the operator types.
 */
export function validateSecretPathForCreate(path: string, store: SecretStore): SecretPathValidation {
  const cleaned = cleanSecretPath(path);
  if (!cleaned.ok) return cleaned;

  const { segments } = cleaned;
  if (segments.length < 3) {
    return { ok: false, message: "Path must have at least 3 segments: <namespace>/<app>/<name>." };
  }

  const [namespace, app] = segments;
  if (!NAMESPACE_PATTERN.test(namespace)) {
    return {
      ok: false,
      message: `Namespace "${namespace}" must be lowercase, start and end with a letter or digit, and use only letters, digits and hyphens.`,
    };
  }
  if (!NAMESPACE_PATTERN.test(app)) {
    return {
      ok: false,
      message: `App "${app}" must be lowercase, start and end with a letter or digit, and use only letters, digits and hyphens.`,
    };
  }

  if (store === "gcpsm") {
    for (const seg of segments) {
      if (!GCPSM_SEGMENT_PATTERN.test(seg)) {
        return {
          ok: false,
          message: `Segment "${seg}" may hold only letters, digits, hyphen and underscore in Google Secret Manager.`,
        };
      }
      if (seg.includes(GCPSM_PATH_SEPARATOR)) {
        return {
          ok: false,
          message: `Segment "${seg}" may not contain "${GCPSM_PATH_SEPARATOR}" — that is how this path is encoded into a Google Secret Manager id, so a segment holding it could not be told apart from a path separator.`,
        };
      }
    }
  }

  return { ok: true, cleaned: segments.join("/") };
}
