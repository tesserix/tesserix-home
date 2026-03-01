import { readFileSync } from "fs";

const K8S_API = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
  : "https://kubernetes.default.svc";

function getServiceAccountToken(): string {
  try {
    return readFileSync(
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
      "utf-8"
    );
  } catch {
    throw new Error("K8s service account token not available (not running in-cluster)");
  }
}

function getCACert(): string | undefined {
  try {
    return readFileSync(
      "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      "utf-8"
    );
  } catch {
    return undefined;
  }
}

async function k8sFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${K8S_API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getServiceAccountToken()}`,
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`K8s API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

export async function rolloutRestart(
  namespace: string,
  deploymentName: string
): Promise<void> {
  // PATCH the deployment with a restart annotation to trigger rollout
  const now = new Date().toISOString();
  await k8sFetch(
    `/apis/apps/v1/namespaces/${namespace}/deployments/${deploymentName}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/strategic-merge-patch+json",
      },
      body: JSON.stringify({
        spec: {
          template: {
            metadata: {
              annotations: {
                "kubectl.kubernetes.io/restartedAt": now,
              },
            },
          },
        },
      }),
    }
  );
}
