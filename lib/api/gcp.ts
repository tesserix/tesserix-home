/**
 * Shared GCP API helpers for server-side route handlers.
 * Uses the metadata server to get access tokens (works on both Cloud Run and GKE with Workload Identity).
 */

const GCP_PROJECT = process.env.GCP_PROJECT_ID || "tesserix";
const GCP_REGION = process.env.GCP_REGION || "us-central1";

export { GCP_PROJECT, GCP_REGION };

export async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) throw new Error("Failed to get GCP access token");
  const { access_token } = await res.json();
  return access_token;
}

export async function gcpFetch<T>(
  url: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GCP API ${res.status}: ${body.slice(0, 300)}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Helper for GCP REST APIs (e.g. Cloud Run, IAM, Pub/Sub, etc.) */
export async function gcpApi<T>(
  path: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  return gcpFetch<T>(`https://${path}`, token, init);
}
