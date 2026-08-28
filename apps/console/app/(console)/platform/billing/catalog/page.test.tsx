import { describe, expect, it } from "vitest";

import { migrationsPendingMessage } from "@/lib/db-read-error";
import { PlatformApiError } from "@/lib/platform-api";
import {
  CATALOG_SURFACE,
  PUBLICATION_SURFACE,
  RUNS_SURFACE,
  WINDOW_SURFACE,
  catalogReadError,
  publicationReadError,
  readCatalogMode,
  runsReadError,
  windowReadError,
} from "./page";

/**
 * The server half's pure functions — the part that can be tested without
 * standing up a React Server Component render, the same split
 * `billing/page.test.tsx` and `audit-log/page.test.tsx` make.
 */

describe("readCatalogMode", () => {
  it("defaults to live, per the task's instruction", () => {
    expect(readCatalogMode({})).toBe("live");
  });

  it("honours an explicit test or live", () => {
    expect(readCatalogMode({ mode: "test" })).toBe("test");
    expect(readCatalogMode({ mode: "live" })).toBe("live");
  });

  it("falls back to live on anything that is not a Stripe mode", () => {
    // An unrecognised or hand-edited `?mode=` must not throw and must not
    // silently show test data under a URL that says nothing about test.
    expect(readCatalogMode({ mode: "sandbox" })).toBe("live");
    expect(readCatalogMode({ mode: ["test", "live"] })).toBe("live");
  });
});

/** A rejection shaped like `pg` reporting a missing relation — the state of
 *  every environment where 0032-0035 have not been applied yet. */
const undefinedTable = () => Object.assign(new Error("relation does not exist"), { code: "42P01" });

describe("read errors — four independent surfaces, four independent narrowings", () => {
  // Each read goes through `dbReadError`, exactly like `audit-log`'s
  // `consoleReadError`: `tesserix-postgres`'s own messages are written for a
  // server log, not for an operator, and the un-migrated case must read as
  // "not set up yet" rather than `relation "plan_catalog_prices" does not
  // exist`.
  it("names the observation window's own surface in the migrations-pending copy", () => {
    const error = windowReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(WINDOW_SURFACE));
  });

  it("names the catalog table's own surface in the migrations-pending copy", () => {
    const error = catalogReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(CATALOG_SURFACE));
  });

  it("names the parity runs' own surface in the migrations-pending copy", () => {
    const error = runsReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(RUNS_SURFACE));
  });

  // The fourth read — task 2R. Same narrowing as the other three: a mode
  // with no publication yet is a normal `null` (see `readPublication`), never
  // an error, so this only ever fires for an actual read failure.
  it("names the publication's own surface in the migrations-pending copy", () => {
    const error = publicationReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(PUBLICATION_SURFACE));
  });

  it("leaves a genuine failure alone, rather than dressing it up as unmigrated", () => {
    const error = windowReadError(new PlatformApiError("connection reset", 503));
    expect(error?.unavailable).toBeUndefined();
  });

  it("leaves a genuine publication read failure alone too, rather than dressing it up as unmigrated", () => {
    // The exact case the brief warns about: a failed publication read must
    // not be mistaken for "migrations pending" when it is a real failure.
    const error = publicationReadError(new PlatformApiError("connection reset", 503));
    expect(error?.unavailable).toBeUndefined();
  });

  it("passes null through for no error", () => {
    expect(windowReadError(null)).toBeNull();
  });
});
