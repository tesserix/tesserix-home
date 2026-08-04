import { describe, expect, it, vi, beforeEach } from "vitest";

const listSecretVersions = vi.fn();
const accessSecretVersion = vi.fn();

vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: class {
    listSecretVersions = listSecretVersions;
    accessSecretVersion = accessSecretVersion;
  },
}));

import { readKeyHealth } from "./key-health";

const DAY = 24 * 60 * 60 * 1000;
function versionsCreatedDaysAgo(...days: number[]) {
  return [
    days.map((d) => ({
      state: "ENABLED",
      createTime: { seconds: Math.floor((Date.now() - d * DAY) / 1000) },
    })),
  ];
}

beforeEach(() => {
  listSecretVersions.mockReset();
  accessSecretVersion.mockReset();
});

describe("readKeyHealth", () => {
  it("counts enabled keys and reports the age of the OLDEST current version", async () => {
    listSecretVersions.mockImplementation(({ parent }: { parent: string }) =>
      parent.endsWith("gemini") ? versionsCreatedDaysAgo(7) : versionsCreatedDaysAgo(30),
    );

    const health = await readKeyHealth("p", ["gemini", "openai"]);
    expect(health.configured).toBe(2);
    // The oldest key is the one at risk, so the tile must surface 30, not 7.
    expect(health.oldestAgeDays).toBe(30);
  });

  // The whole point of the tile: a key that vanished or was disabled must
  // show up as a DROP, not as a silently smaller set.
  it("does not count a secret with no enabled version", async () => {
    listSecretVersions.mockImplementation(({ parent }: { parent: string }) =>
      parent.endsWith("gemini")
        ? versionsCreatedDaysAgo(7)
        : [[{ state: "DESTROYED", createTime: { seconds: 1 } }]],
    );

    const health = await readKeyHealth("p", ["gemini", "openai"]);
    expect(health.configured).toBe(1);
    expect(health.oldestAgeDays).toBe(7);
  });

  it("degrades to zeros when Secret Manager is unreachable", async () => {
    listSecretVersions.mockRejectedValue(new Error("PERMISSION_DENIED"));
    const health = await readKeyHealth("p", ["gemini", "openai"]);
    expect(health).toEqual({ configured: 0, oldestAgeDays: 0 });
  });

  // THE SECURITY BOUNDARY. This module reads metadata and must never pull a
  // secret VALUE into the portal process. Without this test, someone
  // "improving" the panel to show a key prefix would face nothing at all.
  it("never accesses a secret value", async () => {
    listSecretVersions.mockImplementation(() => versionsCreatedDaysAgo(3));
    await readKeyHealth("p", ["gemini", "openai"]);
    expect(accessSecretVersion).not.toHaveBeenCalled();
  });
});
