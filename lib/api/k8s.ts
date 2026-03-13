/**
 * Kubernetes API helpers for server-side route handlers on GKE.
 * Uses the in-cluster service account token mounted at
 * /var/run/secrets/kubernetes.io/serviceaccount/.
 */

import { readFile } from "fs/promises";

const K8S_API = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
  : "";

const K8S_NAMESPACE = process.env.K8S_NAMESPACE || "platform";

export { K8S_NAMESPACE };

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Read the in-cluster service account token (auto-rotated by kubelet). */
export async function getK8sToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) return cachedToken.value;

  const token = await readFile(
    "/var/run/secrets/kubernetes.io/serviceaccount/token",
    "utf-8"
  );
  // Cache for 5 minutes (token is valid much longer, kubelet rotates at 80% of TTL)
  cachedToken = { value: token.trim(), expiresAt: now + 5 * 60 * 1000 };
  return cachedToken.value;
}

/** Read the CA cert for verifying the API server TLS cert. */
async function getCACert(): Promise<string> {
  return readFile(
    "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    "utf-8"
  );
}

/** Fetch from the Kubernetes API with service account auth. */
export async function k8sFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const token = await getK8sToken();
  const url = `${K8S_API}${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...init?.headers,
    },
    // In production, configure NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    // to verify the K8s API server TLS cert.
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`K8s API ${res.status}: ${body.slice(0, 300)}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// ─── K8s API types (subset we need) ───

export interface K8sPod {
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec: {
    containers: Array<{
      name: string;
      image: string;
      env?: Array<{ name: string; value?: string; valueFrom?: unknown }>;
    }>;
  };
  status: {
    phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
    conditions?: Array<{
      type: string;
      status: "True" | "False" | "Unknown";
      lastTransitionTime?: string;
    }>;
    containerStatuses?: Array<{
      name: string;
      ready: boolean;
      restartCount: number;
      image: string;
      started: boolean;
    }>;
  };
}

export interface K8sDeployment {
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec: {
    replicas?: number;
    template: {
      metadata?: { annotations?: Record<string, string> };
      spec: {
        containers: Array<{
          name: string;
          image: string;
          env?: Array<{ name: string; value?: string; valueFrom?: unknown }>;
        }>;
      };
    };
  };
  status: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
    conditions?: Array<{
      type: string;
      status: "True" | "False" | "Unknown";
      reason?: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
  };
}

export interface K8sKnativeService {
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
    generation?: number;
  };
  spec: {
    template: {
      metadata?: {
        annotations?: Record<string, string>;
      };
      spec: {
        containers: Array<{
          name: string;
          image: string;
          env?: Array<{ name: string; value?: string; valueFrom?: unknown }>;
        }>;
      };
    };
  };
  status: {
    url?: string;
    latestCreatedRevisionName?: string;
    latestReadyRevisionName?: string;
    conditions?: Array<{
      type: string;
      status: "True" | "False" | "Unknown";
      reason?: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
    traffic?: Array<{
      revisionName?: string;
      percent?: number;
      latestRevision?: boolean;
    }>;
  };
}

export interface K8sKnativeRevision {
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec: {
    containers: Array<{
      name: string;
      image: string;
    }>;
  };
  status: {
    conditions?: Array<{
      type: string;
      status: "True" | "False" | "Unknown";
      reason?: string;
      message?: string;
    }>;
  };
}

// ─── Knative Service API paths ───

const KNATIVE_GROUP = "serving.knative.dev/v1";

export function knativeServicesPath(namespace: string): string {
  return `/apis/${KNATIVE_GROUP}/namespaces/${namespace}/services`;
}

export function knativeServicePath(namespace: string, name: string): string {
  return `/apis/${KNATIVE_GROUP}/namespaces/${namespace}/services/${name}`;
}

export function knativeRevisionsPath(namespace: string): string {
  return `/apis/${KNATIVE_GROUP}/namespaces/${namespace}/revisions`;
}

// ─── Standard K8s API paths ───

export function deploymentsPath(namespace: string): string {
  return `/apis/apps/v1/namespaces/${namespace}/deployments`;
}

export function deploymentPath(namespace: string, name: string): string {
  return `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`;
}

export function podsPath(namespace: string): string {
  return `/api/v1/namespaces/${namespace}/pods`;
}
