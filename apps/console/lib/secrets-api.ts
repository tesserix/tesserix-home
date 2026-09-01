import { PlatformApiError } from "./platform-api-error";

/** A rejection is not guaranteed to be an `Error` — an undefined `.message`
 *  would read as a mystery failure. Narrow before formatting. Mirrors
 *  `describe` in `platform-api.ts`. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Where secrets-api lives. A second origin, not a second client: the token,
 * the token store and the error type are all shared with platform-api,
 * because both services verify the same Zitadel project audience and the
 * console holds exactly one operator token.
 *
 * Read at call time, not at module load, so tests can stub it and so a
 * misconfigured deployment reports the problem per request rather than
 * failing to start.
 */
export function secretsApiOrigin(): string | undefined {
  const raw = (process.env.SECRETS_API_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return raw === "" ? undefined : raw;
}

/**
 * A single GET-style call against secrets-api, mirroring `platformCall`'s
 * shape (the unwrapping-to-`.data` layer above it, `platformRequest`, has no
 * counterpart here yet — secrets-api does not speak the same envelope). The
 * operator token is the only credential this service accepts, so a missing
 * token is refused before the network call rather than sent and left to come
 * back as an indistinguishable 401.
 */
export async function secretsRequest(label: string, path: string): Promise<unknown> {
  const origin = secretsApiOrigin();
  if (!origin) {
    throw new PlatformApiError(`${label}: SECRETS_API_ORIGIN is not set`, 501);
  }

  const { resolvePlatformApiToken } = await import("./auth/platform-token");
  const { token, reauthRequired } = await resolvePlatformApiToken();
  if (!token) {
    // The marker is set ONLY for the absence a fresh sign-in mints a token
    // for. Marking every tokenless case would tell an operator to sign in
    // again when the encryption key is unset or tesserix-postgres is down —
    // an infrastructure failure dressed as a session failure. See the
    // identical reasoning in `platformCall`.
    throw new PlatformApiError(
      reauthRequired
        ? `${label}: this session carries no platform API access token (ADR-003 D8)`
        : `${label}: could not obtain a platform API access token for this session`,
      undefined,
      { noOperatorToken: reauthRequired },
    );
  }

  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      cache: "no-store",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch (cause) {
    throw new PlatformApiError(`${label}: request failed (${describe(cause)})`, undefined, {
      cause,
    });
  }

  if (!response.ok) {
    // The upstream status is preserved rather than flattened. 403 (lacks the
    // `platform` capability) and 401 (session gone) need different answers
    // from the caller, and only the status tells them apart.
    throw new PlatformApiError(`${label}: secrets-api returned ${response.status}`, response.status);
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new PlatformApiError(
      `${label}: response was not JSON (${describe(cause)})`,
      response.status,
      { cause },
    );
  }
}
