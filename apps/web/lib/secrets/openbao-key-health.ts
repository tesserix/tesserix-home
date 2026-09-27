import { readFile } from "node:fs/promises";
import { logger } from "@/lib/logger";
import type { KeyHealth } from "./key-health";

interface VersionMetadata {
  created_time: string;
  deletion_time: string;
  destroyed: boolean;
}

// Reads only KV metadata; the console role cannot read credential payloads.
export async function readOpenBaoKeyHealth(paths: readonly string[]): Promise<KeyHealth | null> {
  if (paths.some((path) => !/^kora\/app\/kora-[a-z0-9-]+$/.test(path))) return null;
  const address = (process.env.OPENBAO_ADDR || "http://openbao.openbao.svc.cluster.local:8200").replace(/\/$/, "");
  let token: string | undefined;
  try {
    const jwt = await readFile(process.env.OPENBAO_JWT_FILE || "/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
    const login = await fetch(`${address}/v1/auth/kubernetes/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "company-kora-key-metadata", jwt: jwt.trim() }),
      signal: AbortSignal.timeout(5000), cache: "no-store", redirect: "error",
    });
    if (!login.ok) throw new Error("OpenBao authentication unavailable");
    token = (await login.json()).auth?.client_token;
    if (!token) throw new Error("OpenBao authentication returned no token");
    const ages = await Promise.all(paths.map(async (path): Promise<number | null> => {
      const response = await fetch(`${address}/v1/kv/metadata/${path}`, {
        headers: { "X-Vault-Token": token! }, signal: AbortSignal.timeout(5000), cache: "no-store", redirect: "error",
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("OpenBao metadata unavailable");
      const { data } = await response.json() as { data: { current_version: number; versions: Record<string, VersionMetadata> } };
      const version = data.versions[String(data.current_version)];
      if (!version) throw new Error("OpenBao current-version metadata missing");
      if (version.destroyed || version.deletion_time) return null;
      const created = Date.parse(version.created_time);
      if (!Number.isFinite(created)) throw new Error("OpenBao version timestamp invalid");
      return Math.max(0, Math.floor((Date.now() - created) / 86400000));
    }));
    const usable = ages.filter((age): age is number => age !== null);
    return { configured: usable.length, oldestAgeDays: usable.length ? Math.max(...usable) : 0 };
  } catch {
    logger.warn("[key-health] OpenBao metadata unavailable");
    return null;
  } finally {
    if (token) {
      try {
        await fetch(`${address}/v1/auth/token/revoke-self`, {
          method: "POST", headers: { "X-Vault-Token": token }, signal: AbortSignal.timeout(5000), cache: "no-store", redirect: "error",
        });
      } catch { /* The metadata-only token also expires after five minutes. */ }
    }
  }
}
