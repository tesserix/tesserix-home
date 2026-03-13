/**
 * Platform detection for multi-runtime support (Cloud Run vs GKE).
 *
 * Set PLATFORM_MODE env var to explicitly control:
 *   - "cloudrun" (default): uses Cloud Run v2 API via GCP metadata server
 *   - "gke": uses Kubernetes API via in-cluster service account
 *
 * If PLATFORM_MODE is not set, auto-detects based on environment:
 *   - KUBERNETES_SERVICE_HOST present → GKE
 *   - otherwise → Cloud Run
 */

export type PlatformMode = "cloudrun" | "gke";

let detected: PlatformMode | null = null;

export function getPlatformMode(): PlatformMode {
  if (detected) return detected;

  const explicit = process.env.PLATFORM_MODE;
  if (explicit === "gke" || explicit === "cloudrun") {
    detected = explicit;
    return detected;
  }

  // Auto-detect: KUBERNETES_SERVICE_HOST is always set inside a K8s pod
  detected = process.env.KUBERNETES_SERVICE_HOST ? "gke" : "cloudrun";
  return detected;
}

export function isGKE(): boolean {
  return getPlatformMode() === "gke";
}

export function isCloudRun(): boolean {
  return getPlatformMode() === "cloudrun";
}
