import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  parseFollowerReadings,
  refreshFollowerCounts,
  type RefreshFollowersResult,
} from "@/lib/db/crm-followers-refresh";
import { closeTesserixPool, isDatabaseConfigured } from "@/lib/db/tesserix";

/**
 * Write a batch of re-scraped follower counts onto their contacts.
 *
 * `scripts/backfill-lawful-basis.ts` is the pattern; the reasoning there
 * applies unchanged. This file owns argv, exit codes and one JSON log line.
 * What gets matched and what gets refused lives in
 * `lib/db/crm-followers-refresh.ts`.
 *
 * Input is a `handle,followers` file — one lead per line, `#` for comments:
 *
 *   # tier A, re-scraped 2026-09-29
 *   krafty.knots,4054
 *   @kamakshi__clothing,42,200
 *
 * Counts may carry the thousands separators Instagram renders, and the handle
 * may carry its `@`. Both are normalised.
 *
 * DRY RUNS BY DEFAULT — `--commit` writes. Unlike the lawful-basis backfill
 * this one is re-runnable without consequence (a count that has not moved
 * writes nothing), but a mistyped file would put fiction in the funnel's
 * qualification signal, so the safe invocation is still the short one.
 *
 *   node --env-file=<env> dist/refresh-followers.mjs \
 *     --file followers.csv --actor you@tesserix.app
 *   # ...then the same line with --commit
 */

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_GRACE_MS = 5_000;

function log(payload: Record<string, unknown>, stream: "out" | "err"): void {
  const line = JSON.stringify({ job: "refresh-followers", ...payload });
  if (stream === "out") process.stdout.write(line + "\n");
  else process.stderr.write(line + "\n");
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export async function runRefreshFollowersJob(argv: readonly string[]): Promise<number> {
  const file = readFlag(argv, "file");
  const actor = readFlag(argv, "actor");
  const commit = argv.includes("--commit");

  if (file === undefined) {
    log({ outcome: "usage", reason: "--file <path> is required" }, "err");
    return EXIT_USAGE;
  }
  if (actor === undefined || actor.trim().length === 0) {
    log({ outcome: "usage", reason: "--actor is required; it is recorded on every row" }, "err");
    return EXIT_USAGE;
  }
  // PARSED BEFORE THE DATABASE IS CHECKED, deliberately. Reading and
  // validating the file needs no connection, so an operator can lint the list
  // they just pasted together on a laptop with no port-forward open — and the
  // line number they need is the whole value of the error. Checking the
  // environment first would answer a question they had not asked yet.
  let readings;
  try {
    readings = parseFollowerReadings(readFileSync(file, "utf-8"));
  } catch (cause) {
    // A parse failure names the line, and is a usage error rather than a
    // failure: nothing was attempted, and the fix is in the operator's file.
    log(
      { outcome: "usage", reason: cause instanceof Error ? cause.message : String(cause) },
      "err",
    );
    return EXIT_USAGE;
  }

  if (!isDatabaseConfigured()) {
    log({ outcome: "usage", reason: "tesserix DB env not set" }, "err");
    return EXIT_USAGE;
  }

  try {
    const result: RefreshFollowersResult = await refreshFollowerCounts({
      readings,
      actor: actor.trim(),
      dryRun: !commit,
    });
    log(
      {
        outcome: "ok",
        actor: actor.trim(),
        dryRun: !commit,
        readings: readings.length,
        ...result,
      },
      "out",
    );
    // Unmatched handles do NOT fail the run — a voided or erased lead dropping
    // out of the target list is expected, and is reported in the payload for a
    // human to read. A write that raised is a different matter.
    return result.failures.length > 0 ? EXIT_FAILED : EXIT_OK;
  } catch (cause) {
    log(
      { outcome: "failed", reason: cause instanceof Error ? cause.message : String(cause) },
      "err",
    );
    return EXIT_FAILED;
  } finally {
    await closeTesserixPool().catch(() => {});
  }
}

/** Only when run as a program, never when imported by a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void runRefreshFollowersJob(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
  });
}
