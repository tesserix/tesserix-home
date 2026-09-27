import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => "test-jwt") }));
import { readOpenBaoKeyHealth } from "./openbao-key-health";
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
function fixture(status = 200, deleted = false) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/login")) return Response.json({ auth: { client_token: "test-token" } });
    if (url.endsWith("/revoke-self")) return new Response(null, { status: 204 });
    if (status !== 200) return new Response(null, { status });
    return Response.json({ data: { current_version: 2, versions: { "2": { created_time: new Date(Date.now() - 7 * 86400000).toISOString(), deletion_time: deleted ? "now" : "", destroyed: false } } } });
  });
}
describe("OpenBao key health", () => {
  it("reads metadata only, authenticates, and revokes its token", async () => {
    fixture();
    expect(await readOpenBaoKeyHealth(["kora/app/kora-key"])).toEqual({ configured: 1, oldestAgeDays: 7 });
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls.some((url) => url.includes("/kv/data/"))).toBe(false);
    expect(urls.some((url) => url.endsWith("/kv/metadata/kora/app/kora-key"))).toBe(true);
    expect(urls.at(-1)).toMatch(/revoke-self$/);
  });
  it.each([403, 500])("reports unknown for HTTP %d instead of a missing key", async (code) => {
    fixture(code); expect(await readOpenBaoKeyHealth(["kora/app/kora-key"])).toBeNull();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toMatch(/revoke-self$/);
  });
  it("does not count a deleted current version or an absent secret", async () => {
    fixture(200, true); expect(await readOpenBaoKeyHealth(["kora/app/kora-key"])).toEqual({ configured: 0, oldestAgeDays: 0 });
    fixture(404); expect(await readOpenBaoKeyHealth(["kora/app/kora-key"])).toEqual({ configured: 0, oldestAgeDays: 0 });
  });
  it("rejects path traversal before authentication", async () => {
    expect(await readOpenBaoKeyHealth(["../platform/key"])).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
  });
});
