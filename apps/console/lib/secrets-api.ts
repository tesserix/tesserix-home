import { PlatformApiError } from "./platform-api-error";

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
 * A single GET-style call against secrets-api, mirroring `platformRequest`'s
 * shape. The operator token is the only credential this service accepts, so a
 * missing token is refused before the network call rather than sent and left
 * to come back as an indistinguishable 401.
 */
export async function secretsRequest(label: string, path: string): Promise<unknown> {
  const origin = secretsApiOrigin();
  if (!origin) {
    throw new PlatformApiError(`${label}: SECRETS_API_ORIGIN is not set`, 501);
  }

  const { getPlatformApiToken } = await import("./auth/platform-token");
  const token = await getPlatformApiToken();
  if (!token) {
    throw new PlatformApiError(`${label}: no operator token`, undefined, {
      noOperatorToken: true,
    });
  }

  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    // The upstream status is preserved rather than flattened. 403 (lacks the
    // `platform` capability) and 401 (session gone) need different answers
    // from the caller, and only the status tells them apart.
    throw new PlatformApiError(`${label}: secrets-api returned ${response.status}`, response.status);
  }

  return response.json();
}
