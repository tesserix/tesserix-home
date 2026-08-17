import { describe, expect, it } from "vitest";
import { isSafeWebsiteUrl } from "./crm-url";

describe("isSafeWebsiteUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isSafeWebsiteUrl("https://bondibaker.example")).toBe(true);
    expect(isSafeWebsiteUrl("http://bondibaker.example")).toBe(true);
  });

  // The stored value reaches an `<a href target="_blank">` verbatim
  // (`[organisation]/page.tsx`) — a `javascript:` scheme there is a stored
  // XSS payload waiting for the next operator to click it.
  it("rejects a javascript: URL", () => {
    expect(isSafeWebsiteUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects other non-http(s) schemes", () => {
    expect(isSafeWebsiteUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeWebsiteUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeWebsiteUrl("file:///etc/passwd")).toBe(false);
  });

  // `new URL(...)` in a try/catch, not a regex — an unparseable string must
  // fail closed, not crash the caller.
  it("rejects a string that does not parse as a URL", () => {
    expect(isSafeWebsiteUrl("not a url")).toBe(false);
    expect(isSafeWebsiteUrl("")).toBe(false);
  });
});
