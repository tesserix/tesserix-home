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
  it("does NOT pin login to an organization", () => {
    // Regression guard. Pinning login to the project's org made Zitadel try to
    // authenticate operators as members of an org none of them belong to —
    // every human account lives in a different org from the project — so it
    // fell through to auto-creation and failed with `409 User already exists`
    // against the globally-unique username they already held. Auto-linking
    // could not rescue it: that search is scoped to the org being signed into.
    //
    // Role grants are project-scoped, so roles resolve wherever the user lives.
    expect(scopesFor(CONFIG)).not.toContain("urn:zitadel:iam:org:id:");
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
    });
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["no separator", "abc123"],
    ["empty nonce", ".Zm9v"],
  ])("rejects malformed state: %s", (_label, state) => {
    expect(decodeState(state)).toBeNull();
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
