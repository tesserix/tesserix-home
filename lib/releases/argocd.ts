const ARGOCD_URL =
  process.env.ARGOCD_API_URL || "https://argocd-server.argocd.svc.cluster.local";

function getToken(): string {
  const token = process.env.ARGOCD_AUTH_TOKEN;
  if (!token) throw new Error("ARGOCD_AUTH_TOKEN is not configured");
  return token;
}

async function argoFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ARGOCD_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...init?.headers,
    },
    // ArgoCD uses self-signed certs in-cluster
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ArgoCD API ${res.status}: ${body.slice(0, 200)}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export async function syncApp(appName: string): Promise<void> {
  await argoFetch(`/api/v1/applications/${appName}/sync`, {
    method: "POST",
    body: JSON.stringify({
      strategy: { hook: {} },
      prune: true,
    }),
  });
}

export async function getAppStatus(
  appName: string
): Promise<{ health: string; sync: string }> {
  const data = await argoFetch<{
    status: {
      health: { status: string };
      sync: { status: string };
    };
  }>(`/api/v1/applications/${appName}`);
  return {
    health: data.status.health.status,
    sync: data.status.sync.status,
  };
}
