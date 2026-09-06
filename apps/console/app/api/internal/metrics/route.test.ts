import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/db/plan-catalog-repo", () => ({
  readLatestRuns: vi.fn(),
  readLastCleanRuns: vi.fn(),
  readWindowStatus: vi.fn(),
}));

import { CATALOG_SOURCES } from "@/lib/billing/source-policy";
import { STRIPE_MODES } from "@/lib/billing/stripe-read";
import {
  readLastCleanRuns,
  readLatestRuns,
  readWindowStatus,
} from "@/lib/db/plan-catalog-repo";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import { OBSERVATION_WINDOW_DAYS } from "@/lib/billing/observation-window";
import { GET } from "./route";

/**
 * The console's first metrics endpoint, and the only machine-readable account
 * of the catalog↔Stripe parity check.
 *
 * Two properties carry the suite, and both are about what an ALERT written
 * against this output will conclude:
 *
 * 1. EVERY (mode, source) PAIR EMITS A SAMPLE, always — the same "every pair,
 *    always" discipline `readLatestRuns` and `readWindowStatus` document. An
 *    omitted series is indistinguishable from a scrape failure, and an alert
 *    that cannot tell those apart is one nobody believes.
 * 2. NO FREE TEXT EVER REACHES THE OUTPUT. The stored `error` is redacted for
 *    one operator reading one row on one page; this output is retained,
 *    indexed and broadly readable. Numbers only.
 */

/** How the tests read the exposition back — one entry per sample line, so an
 *  assertion is about a parsed sample rather than a substring of a blob. */
function parse(body: string): {
  help: Record<string, string>;
  type: Record<string, string>;
  samples: { name: string; labels: Record<string, string>; value: string }[];
} {
  const help: Record<string, string> = {};
  const type: Record<string, string> = {};
  const samples: { name: string; labels: Record<string, string>; value: string }[] = [];

  for (const line of body.split("\n")) {
    if (line === "") continue;
    const helpMatch = /^# HELP (\S+) (.+)$/.exec(line);
    if (helpMatch) {
      help[helpMatch[1]] = helpMatch[2];
      continue;
    }
    const typeMatch = /^# TYPE (\S+) (\S+)$/.exec(line);
    if (typeMatch) {
      type[typeMatch[1]] = typeMatch[2];
      continue;
    }
    // Any other `#` line would be a comment this endpoint does not write; a
    // sample line that failed to match below is a format bug, so it must not
    // be silently skipped.
    const sampleMatch = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (\S+)$/.exec(line);
    expect(sampleMatch, `unparseable exposition line: ${line}`).not.toBeNull();
    const labels: Record<string, string> = {};
    for (const pair of sampleMatch![3]?.split(",") ?? []) {
      if (pair === "") continue;
      const labelMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)="(.*)"$/.exec(pair);
      expect(labelMatch, `unparseable label: ${pair}`).not.toBeNull();
      labels[labelMatch![1]] = labelMatch![2];
    }
    samples.push({ name: sampleMatch![1], labels, value: sampleMatch![4] });
  }

  return { help, type, samples };
}

const PAIRS = STRIPE_MODES.flatMap((mode) =>
  CATALOG_SOURCES.map((source) => ({ mode, source })),
);

const DIFFERENCES = "tesserix_console_stripe_parity_differences";
const LAST_CLEAN = "tesserix_console_stripe_parity_last_clean_timestamp_seconds";
const WINDOW = "tesserix_console_stripe_parity_window_satisfied";

/** The all-clean fixture the tests vary from, built off the constants rather
 *  than written out, so a second source added to `CATALOG_SOURCES` and not
 *  covered by the route fails here. */
function allPairs<T>(value: (mode: string, source: string) => T): T[] {
  return PAIRS.map(({ mode, source }) => value(mode, source));
}

function healthy(): void {
  vi.mocked(readLatestRuns).mockResolvedValue(
    allPairs((mode, source) => ({
      mode,
      source,
      run: {
        outcome: "clean",
        ranAt: "2026-09-06T02:15:00.000Z",
        differenceCount: 0,
        differences: [],
        error: null,
      },
    })) as never,
  );
  vi.mocked(readLastCleanRuns).mockResolvedValue(
    allPairs((mode, source) => ({
      mode,
      source,
      ranAt: "2026-09-06T02:15:00.000Z",
    })) as never,
  );
  vi.mocked(readWindowStatus).mockResolvedValue({
    days: OBSERVATION_WINDOW_DAYS,
    pairs: [],
    satisfied: true,
  } as never);
}

async function body(): Promise<string> {
  const res = await GET();
  return res.text();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  healthy();
});

describe("the exposition itself", () => {
  it("serves the Prometheus text format with the version the format requires", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );
  });

  it("carries HELP and TYPE for every series it emits", async () => {
    const { help, type, samples } = parse(await body());

    for (const name of [DIFFERENCES, LAST_CLEAN, WINDOW]) {
      // A metric with no HELP is one an operator meets for the first time at
      // 3am with nothing but its name to go on.
      expect(help[name], `${name} has no HELP`).toBeTruthy();
      expect(type[name]).toBe("gauge");
    }
    expect(samples.length).toBeGreaterThan(0);
  });

  it("ends with a newline, as the format requires", async () => {
    expect(await body()).toMatch(/\n$/);
  });
});

describe("every (mode, source) pair emits a sample", () => {
  it("covers the whole cross product for both per-pair series", async () => {
    const { samples } = parse(await body());

    for (const name of [DIFFERENCES, LAST_CLEAN]) {
      const emitted = samples
        .filter((s) => s.name === name)
        .map((s) => `${s.labels.mode}/${s.labels.source}`);
      expect(emitted.sort()).toEqual(
        PAIRS.map(({ mode, source }) => `${mode}/${source}`).sort(),
      );
    }
  });

  it("emits a sample for a pair that has NEVER run, rather than omitting it", async () => {
    // The property the whole design rests on. An absent series reads exactly
    // like a scrape that failed, which is the confusion tesserix-k8s#1018
    // was; a pair nothing has ever checked has to SAY so.
    vi.mocked(readLatestRuns).mockResolvedValue(
      allPairs((mode, source) => ({ mode, source, run: null })) as never,
    );
    vi.mocked(readLastCleanRuns).mockResolvedValue(
      allPairs((mode, source) => ({ mode, source, ranAt: null })) as never,
    );

    const { samples } = parse(await body());

    expect(samples.filter((s) => s.name === DIFFERENCES)).toHaveLength(PAIRS.length);
    expect(samples.filter((s) => s.name === LAST_CLEAN)).toHaveLength(PAIRS.length);
  });

  it("reports a never-clean pair as an epoch timestamp, not as a missing sample", async () => {
    // 0 means "last clean in 1970", so `time() - <gauge>` is enormous and a
    // staleness alert fires — the same reading `CatalogParityStale` in
    // tesserix-k8s relies on for a pod that has never succeeded.
    vi.mocked(readLastCleanRuns).mockResolvedValue(
      allPairs((mode, source) => ({ mode, source, ranAt: null })) as never,
    );

    const { samples } = parse(await body());

    for (const sample of samples.filter((s) => s.name === LAST_CLEAN)) {
      expect(sample.value).toBe("0");
    }
  });

  it("reports the last clean run's unix seconds when there is one", async () => {
    const { samples } = parse(await body());

    for (const sample of samples.filter((s) => s.name === LAST_CLEAN)) {
      expect(Number(sample.value)).toBe(Date.parse("2026-09-06T02:15:00.000Z") / 1000);
    }
  });

  it("reports the last run's difference count", async () => {
    vi.mocked(readLatestRuns).mockResolvedValue(
      allPairs((mode, source) => ({
        mode,
        source,
        run: {
          outcome: "differences",
          ranAt: "2026-09-06T02:15:00.000Z",
          differenceCount: 3,
          differences: [],
          error: null,
        },
      })) as never,
    );

    const { samples } = parse(await body());

    for (const sample of samples.filter((s) => s.name === DIFFERENCES)) {
      expect(sample.value).toBe("3");
    }
  });

  it("never reports 0 differences for a run that produced no comparison", async () => {
    // A `failed` run stores `difference_count = 0` because it never compared
    // anything. Emitting that 0 would assert agreement the check did not
    // observe — the single most dangerous lie this endpoint could tell, since
    // it gates a credential revocation. NaN is a real sample (so the series is
    // present) that satisfies no `> 0` comparison and reads as "no value".
    vi.mocked(readLatestRuns).mockResolvedValue(
      allPairs((mode, source) => ({
        mode,
        source,
        run: {
          outcome: "failed",
          ranAt: "2026-09-06T02:15:00.000Z",
          differenceCount: 0,
          differences: [],
          error: "stripe unreachable",
        },
      })) as never,
    );

    const { samples } = parse(await body());

    const values = samples.filter((s) => s.name === DIFFERENCES).map((s) => s.value);
    expect(values).toHaveLength(PAIRS.length);
    expect(values.every((v) => v === "NaN")).toBe(true);
  });

  it("does not report a never-run pair as 0 differences either", async () => {
    vi.mocked(readLatestRuns).mockResolvedValue(
      allPairs((mode, source) => ({ mode, source, run: null })) as never,
    );

    const { samples } = parse(await body());

    expect(
      samples.filter((s) => s.name === DIFFERENCES).every((s) => s.value === "NaN"),
    ).toBe(true);
  });
});

describe("the window gauge", () => {
  it("is 1 when the window is satisfied", async () => {
    const { samples } = parse(await body());
    const window = samples.filter((s) => s.name === WINDOW);

    expect(window).toHaveLength(1);
    expect(window[0].labels).toEqual({});
    expect(window[0].value).toBe("1");
  });

  it("is 0 when it is not", async () => {
    vi.mocked(readWindowStatus).mockResolvedValue({
      days: OBSERVATION_WINDOW_DAYS,
      pairs: [],
      satisfied: false,
    } as never);

    const { samples } = parse(await body());
    expect(samples.find((s) => s.name === WINDOW)?.value).toBe("0");
  });

  it("asks for the same window the console's own surface reports", async () => {
    // #327's gate is one number. Two surfaces answering it over different
    // windows would let the badge and the alert disagree while both were
    // "right".
    await GET();
    expect(vi.mocked(readWindowStatus)).toHaveBeenCalledWith(OBSERVATION_WINDOW_DAYS);
  });
});

describe("no free text can reach the output", () => {
  it("emits nothing from a stored error, however it is shaped", async () => {
    // Fed through the one field that carries operator-facing prose. If any of
    // this can appear, so can whatever a future upstream error message
    // contains — which is why the assertion is on the CATASTROPHIC shape and
    // on the prose alike.
    const secretish = ["sk", "live", "9aZbQ2mmNOTAREALKEY"].join("_");
    const nasty = `boom ${secretish} host=tesserix-postgres user=tesserix_admin\ninjected_metric 1`;
    vi.mocked(readLatestRuns).mockResolvedValue(
      allPairs((mode, source) => ({
        mode,
        source,
        run: {
          outcome: "failed",
          ranAt: "2026-09-06T02:15:00.000Z",
          differenceCount: 0,
          differences: [],
          error: nasty,
        },
      })) as never,
    );

    const text = await body();

    expect(text).not.toContain(secretish);
    expect(text).not.toContain("boom");
    expect(text).not.toContain("tesserix_admin");
    expect(text).not.toContain("injected_metric");
  });

  it("emits only labels drawn from the closed vocabularies", async () => {
    const { samples } = parse(await body());

    for (const sample of samples) {
      for (const [name, value] of Object.entries(sample.labels)) {
        expect(["mode", "source"]).toContain(name);
        if (name === "mode") expect(STRIPE_MODES as readonly string[]).toContain(value);
        if (name === "source") expect(CATALOG_SOURCES as readonly string[]).toContain(value);
      }
    }
  });

  it("escapes a label value that would otherwise break the format", async () => {
    // The vocabularies are closed today, so nothing reaching this needs
    // escaping. The escaping exists so that stays true structurally rather
    // than by inspection — a source named with a quote would otherwise emit a
    // line no parser could read.
    vi.mocked(readLatestRuns).mockResolvedValue([
      {
        mode: 'te"st\\',
        source: "mark8ly",
        run: null,
      },
    ] as never);
    vi.mocked(readLastCleanRuns).mockResolvedValue([] as never);

    const text = await body();

    expect(text).toContain('mode="te\\"st\\\\"');
    // And it still parses, which is the point of escaping at all.
    expect(() => parse(text)).not.toThrow();
  });
});

describe("when the database cannot answer", () => {
  it("fails the scrape rather than reporting zeros, when it is not configured", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    const res = await GET();

    expect(res.status).toBe(501);
    const text = await res.text();
    expect(text).not.toContain(DIFFERENCES);
    expect(text).not.toContain(WINDOW);
  });

  it("fails the scrape when a read throws", async () => {
    vi.mocked(readWindowStatus).mockRejectedValue(
      new Error("connect ECONNREFUSED tesserix-postgres:5432 user=tesserix_admin"),
    );

    const res = await GET();

    expect(res.status).toBe(503);
    const text = await res.text();
    // The failure must not carry the driver's account of itself into a
    // retained, broadly readable surface.
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("tesserix_admin");
    expect(text).not.toContain(DIFFERENCES);
  });

  it("does not emit a satisfied window it could not read", async () => {
    vi.mocked(readLatestRuns).mockRejectedValue(new Error("nope"));

    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(WINDOW);
  });
});
