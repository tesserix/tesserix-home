import { pathToFileURL } from "node:url";

import {
  backfillLawfulBasis,
  type BackfillLawfulBasisResult,
} from "@/lib/db/crm-lawful-basis-backfill";
import { isSelectableLawfulBasis, SELECTABLE_LAWFUL_BASES } from "@/lib/crm-provenance";
import { closeTesserixPool, isDatabaseConfigured } from "@/lib/db/tesserix";

/**
 * Record a lawful basis against the contacts the migration left without one
 * (#248), as an operator runs it once.
 *
 * `scripts/catalog-bootstrap.ts` is the pattern, and its reasoning applies
 * unchanged: whoever runs this has a database connection rather than an
 * operator session, and the decision of what to change lives in
 * `lib/db/crm-lawful-basis-backfill.ts`, not here. This file owns argv, exit
 * codes and the one JSON log line the run leaves behind.
 *
 * ══ `--actor` IS REQUIRED, AND IS NOT A FORMALITY ══
 *
 * It becomes `crm_activities.actor` on every row this writes, and the whole
 * point of recording a lawful basis is being able to answer "who determined
 * this, and when". A default here — `system`, the pod name, anything — would
 * put a value in that column that names nobody, which is the same as not
 * recording it. So it is refused rather than defaulted, exactly as
 * `UpdateContactInput.actor` is refused rather than defaulted.
 *
 * ══ IT DRY RUNS BY DEFAULT ══
 *
 * Writing requires `--commit`. This touches every migrated contact in one
 * pass against a production database, and the failure mode of getting the
 * basis wrong is a compliance record that confidently states something
 * untrue — so the safe invocation is the short one and the writing one has
 * to be asked for.
 *
 *   node --env-file=.env.development dist/backfill-lawful-basis.mjs \
 *     --basis legitimate_interests --actor you@tesserix.app
 *   # ...then the same line with --commit
 */

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_GRACE_MS = 5_000;

function log(payload: Record<string, unknown>, stream: "out" | "err"): void {
  const line = JSON.stringify({ job: "backfill-lawful-basis", ...payload });
  if (stream === "out") process.stdout.write(line + "\n");
  else process.stderr.write(line + "\n");
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export async function runBackfillLawfulBasisJob(argv: readonly string[]): Promise<number> {
  const basis = readFlag(argv, "basis");
  const actor = readFlag(argv, "actor");
  const limitRaw = readFlag(argv, "limit");
  const commit = argv.includes("--commit");

  const selectable = SELECTABLE_LAWFUL_BASES.map((option) => option.value).join(", ");
  if (basis === undefined || !isSelectableLawfulBasis(basis)) {
    log({ outcome: "usage", reason: `--basis must be one of: ${selectable}` }, "err");
    return EXIT_USAGE;
  }
  if (actor === undefined || actor.trim().length === 0) {
    log({ outcome: "usage", reason: "--actor is required; it is recorded on every row" }, "err");
    return EXIT_USAGE;
  }
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    log({ outcome: "usage", reason: "--limit must be a positive integer" }, "err");
    return EXIT_USAGE;
  }
  if (!isDatabaseConfigured()) {
    log({ outcome: "usage", reason: "tesserix DB env not set" }, "err");
    return EXIT_USAGE;
  }

  try {
    const result: BackfillLawfulBasisResult = await backfillLawfulBasis({
      basis,
      actor: actor.trim(),
      dryRun: !commit,
      limit,
    });
    // `dryRun` is logged beside the counts for `catalog-bootstrap`'s reason:
    // the field names do not change between a rehearsal and a real run, so
    // it is the only thing telling the two lines apart. `candidates` means
    // "would change" on a dry run and "were considered" on a real one.
    log({ outcome: "ok", basis, actor: actor.trim(), dryRun: !commit, ...result }, "out");
    // Failures are reported in the payload AND in the exit code: a run that
    // skipped rows is not a run that succeeded, and a caller that only reads
    // the status must not be told otherwise.
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

/** Only when run as a program, never when imported by a test — the guard
 *  `catalog-bootstrap.ts` uses, for the same reason. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void runBackfillLawfulBasisJob(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
  });
}
