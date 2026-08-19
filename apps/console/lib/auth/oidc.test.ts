import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  decodeState,
  encodeState,
  safeReturnPath,
  scopesFor,
  type ConsoleOidcConfig,
} from "./oidc";

const CONFIG: ConsoleOidcConfig = {
  issuer: "https://auth.tesserix.app",
  clientId: "386382971877196703",
  clientSecret: "not-a-real-secret",
  redirectUri: "https://console.tesserix.app/auth/callback",
  internalOrgId: "386261254651576970",
  projectId: "386377618200461939",
};

describe("scopes", () => {
  it("does not pin login to an organization when none is configured", () => {
    // Unset keeps the previous behaviour, so this change cannot alter an
    // environment that has not opted in.
    expect(scopesFor(CONFIG)).not.toContain("urn:zitadel:iam:org:id:");
  });

  it("pins login to the configured organization", () => {
    // The scope was removed once, for a reason with a precondition that no
    // longer holds: the same person existed in two orgs, so scoping made
    // Zitadel auto-create and fail with `409 User already exists`. The
    // duplicates were removed on 2026-08-19, and their absence broke login the
    // other way — an unscoped login resolves in the INSTANCE DEFAULT org, which
    // is not where the operators live.
    //
    // Naming the org is what makes the console independent of an instance-wide
    // default that anything else could change.
    const scopes = scopesFor({ ...CONFIG, orgId: "386377229942128837" });

    expect(scopes).toContain("urn:zitadel:iam:org:id:386377229942128837");
  });

  it("keeps the org scope distinct from the project audience", () => {
    // Two different urn prefixes doing two different jobs. Confusing them
    // yields a token with no roles or a login that refuses everyone, and both
    // read as application bugs.
    const scopes = scopesFor({ ...CONFIG, orgId: "999" }).split(" ");

    expect(scopes).toContain("urn:zitadel:iam:org:id:999");
    expect(scopes).toContain(
      "urn:zitadel:iam:org:project:id:386377618200461939:aud",
    );
  });

  it("requests the project audience so roles appear in the token", () => {
    // The belt to the project/application checkboxes' braces. When those are
    // wrong the token is perfectly valid and carries no roles at all, which
    // presents as an application bug rather than a configuration gap.
    expect(scopesFor(CONFIG)).toContain(
      "urn:zitadel:iam:org:project:id:386377618200461939:aud",
    );
  });

  it("requests the standard OIDC scopes", () => {
    const scopes = scopesFor(CONFIG).split(" ");
    expect(scopes).toEqual(expect.arrayContaining(["openid", "profile", "email"]));
  });
});

describe("buildAuthorizationUrl", () => {
  const url = new URL(
    buildAuthorizationUrl(CONFIG, { state: "s.abc", nonce: "n123" }),
  );

  it("targets Zitadel's authorize endpoint", () => {
    expect(url.origin + url.pathname).toBe(
      "https://auth.tesserix.app/oauth/v2/authorize",
    );
  });

  it("requests an authorization code, not an implicit token", () => {
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("carries state and nonce", () => {
    expect(url.searchParams.get("state")).toBe("s.abc");
    expect(url.searchParams.get("nonce")).toBe("n123");
  });

  it("never puts the client secret in the authorization URL", () => {
    expect(url.toString()).not.toContain(CONFIG.clientSecret);
  });
});

describe("state round trip", () => {
  it("recovers the nonce and return path", () => {
    const state = encodeState("abc123", "/platform/tickets?status=open");
    expect(decodeState(state)).toEqual({
      nonce: "abc123",
      returnTo: "/platform/tickets?status=open",
      retried: false,
    });
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["no separator", "abc123"],
    ["empty nonce", ".Zm9v"],
    ["empty path", "abc123."],
    ["too many segments", "abc123.Zm9v.r.r"],
    ["an unrecognised flag", "abc123.Zm9v.x"],
  ])("rejects malformed state: %s", (_label, state) => {
    expect(decodeState(state)).toBeNull();
  });

  it("carries the one-shot retry flag through a round trip", () => {
    const state = encodeState("abc123", "/platform", { retried: true });
    expect(decodeState(state)).toEqual({
      nonce: "abc123",
      returnTo: "/platform",
      retried: true,
    });
  });

  it("still reads a state minted by the previous revision", () => {
    // Mid-rollout a login started on the old code lands on the new code. A
    // `state` this cannot parse is a bad_state failure for a login that was
    // going fine, so the two-segment form has to keep working verbatim.
    const legacy = `abc123.${Buffer.from("/platform").toString("base64url")}`;
    expect(decodeState(legacy)).toEqual({
      nonce: "abc123",
      returnTo: "/platform",
      retried: false,
    });
  });

  it("cannot have the retry guard stripped by a forged state", () => {
    // If an unrecognised third segment decoded as "not a retry", anyone able to
    // hand the browser a state could re-arm the retry forever.
    expect(decodeState("abc123.Zm9v.retried=false")).toBeNull();
  });
});

describe("safeReturnPath", () => {
  it("keeps a same-origin relative path", () => {
    expect(safeReturnPath("/platform/tickets")).toBe("/platform/tickets");
  });

  it.each([
    ["an absolute URL", "https://evil.example/steal"],
    ["protocol-relative", "//evil.example"],
    ["backslash variant", "/\\evil.example"],
    ["a bare word", "platform"],
    ["null", null],
  ])("refuses %s", (_label, raw) => {
    expect(safeReturnPath(raw)).toBe("/");
  });

  it("refuses an open redirect smuggled through state", () => {
    // `state` survives a round trip through Zitadel and Google, so it must be
    // treated as attacker-influenced even though we generated it.
    const state = encodeState("abc123", "https://evil.example/");
    expect(decodeState(state)?.returnTo).toBe("/");
  });
});
