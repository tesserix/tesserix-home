import { describe, expect, it } from "vitest";
import {
  ROUTE_IDS,
  consolePath,
  isPending,
  isRouteActive,
  mobilePath,
  webPath,
} from "./routes";

describe("consolePath", () => {
  it("never serves apps/web's /admin paths", () => {
    // The console is not a second copy of the old admin. Serving `/admin/*` on
    // a host that IS the admin would read as a leftover, and would tie the
    // console's URLs to an app being deleted.
    for (const id of ROUTE_IDS) {
      expect(consolePath(id), `${id} leaks a web path into the console`).not.toMatch(
        /^\/admin\//,
      );
    }
  });

  it("falls back to the mobile path when no console path is set", () => {
    // The fallback is what keeps this a 3-line change rather than 22 invented
    // URLs. It only holds while the shapes agree — see the divergence test.
    // "platform.dashboard" is excluded: it sets an explicit `console: "/"`
    // because the console root, not `/platform`, is where that surface lives.
    for (const id of ROUTE_IDS) {
      if (id === "platform.dashboard") continue;
      expect(consolePath(id)).toBe(mobilePath(id));
    }
  });

  it("serves the console root for the dashboard, not the mobile path", () => {
    // platform.dashboard is the one entry with a real console/mobile
    // divergence: the console root ("/") already is the estate map plus the
    // internal tools directory, which is not the same surface `mobile`
    // ("/platform") points at.
    expect(consolePath("platform.dashboard")).toBe("/");
    expect(consolePath("platform.dashboard")).not.toBe(mobilePath("platform.dashboard"));
  });

  it("keeps web paths distinct from console paths", () => {
    for (const id of ROUTE_IDS) {
      expect(webPath(id)).not.toBe(consolePath(id));
    }
  });
});

describe("isRouteActive understands the console prefix", () => {
  it("matches a console path exactly", () => {
    expect(isRouteActive("/platform/tickets", "platform.tickets", "console")).toBe(
      true,
    );
  });

  it("matches nested routes under a non-exact entry", () => {
    expect(
      isRouteActive("/platform/tickets/M8-1042", "platform.tickets", "console"),
    ).toBe(true);
  });

  it("does not match on a bare string prefix", () => {
    // The bug this guards: `/platform/ticketsXYZ` shares a prefix with
    // `/platform/tickets` but is a different route.
    expect(
      isRouteActive("/platform/ticketsXYZ", "platform.tickets", "console"),
    ).toBe(false);
  });

  it("does not confuse the web path for the console one", () => {
    expect(
      isRouteActive("/admin/platform-tickets", "platform.tickets", "console"),
    ).toBe(false);
  });
});

describe("pending reflects what the console actually serves", () => {
  it("has tickets built", () => {
    // The first surface to land here. If this flips back to pending without
    // the page being removed, the rail stops linking a page that works.
    expect(isPending("platform.tickets")).toBe(false);
  });

  it("has the dashboard built", () => {
    // The console root ("/") is the estate map plus the internal tools
    // directory — that surface exists, so the rail must not badge it SOON
    // or block the palette from offering it.
    expect(isPending("platform.dashboard")).toBe(false);
  });

  it("still reports the unbuilt surfaces as pending", () => {
    // Guards against a blanket un-pend: the rail must not offer navigation to
    // pages that do not exist.
    expect(isPending("kora.foods")).toBe(true);
  });
});
