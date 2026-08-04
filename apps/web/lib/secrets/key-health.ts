// Read-only health of a product's AI provider keys.
//
// METADATA ONLY: this module calls listSecretVersions and NEVER
// accessSecretVersion, so no secret value is ever pulled into the portal
// process. A test pins that. If you are here to add a "show the key prefix"
// affordance, that is a different feature with a different threat model —
// design it, don't bolt it on.
//
// Rotation is deliberately NOT offered here. Kora's keys arrive as pod ENV
// VARS via an ExternalSecret with a 1h refreshInterval, so writing a new
// version rotates nothing until ESO refreshes AND the pod restarts. A button
// that writes a version and reports success would be lying about a
// three-step operation.
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

import { logger } from "@/lib/logger";

export interface KeyHealth {
  readonly configured: number;
  readonly oldestAgeDays: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

let client: SecretManagerServiceClient | null = null;
function getClient(): SecretManagerServiceClient {
  if (!client) client = new SecretManagerServiceClient();
  return client;
}

// Age of a secret's newest ENABLED version, in whole days. null when the
// secret has no usable version at all — which is the state worth alarming on.
async function currentVersionAgeDays(projectId: string, name: string): Promise<number | null> {
  const [versions] = await getClient().listSecretVersions({
    parent: `projects/${projectId}/secrets/${name}`,
  });

  let newestSeconds = 0;
  for (const v of versions ?? []) {
    if (v.state !== "ENABLED") continue;
    const seconds = Number(v.createTime?.seconds ?? 0);
    if (seconds > newestSeconds) newestSeconds = seconds;
  }
  if (newestSeconds === 0) return null;
  return Math.floor((Date.now() - newestSeconds * 1000) / MS_PER_DAY);
}

// readKeyHealth reports how many of the named secrets have a usable version,
// and how stale the STALEST of them is — the oldest key is the one at risk, so
// a fresh rotation of one key must not mask another that was never touched.
export async function readKeyHealth(
  projectId: string,
  secretNames: ReadonlyArray<string>,
): Promise<KeyHealth> {
  try {
    const ages = await Promise.all(
      secretNames.map((name) => currentVersionAgeDays(projectId, name)),
    );
    const usable = ages.filter((a): a is number => a !== null);
    return {
      configured: usable.length,
      oldestAgeDays: usable.length > 0 ? Math.max(...usable) : 0,
    };
  } catch (err) {
    logger.warn(`[key-health] ${err instanceof Error ? err.message : "failed"}`);
    return { configured: 0, oldestAgeDays: 0 };
  }
}
