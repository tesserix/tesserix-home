import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DRAFT_DOES_NOT_SEND,
  UNREACHABLE_AUTH_KEYS,
  emailTemplateFailureMessage,
  failureSentence,
  parseEmailTemplateDetail,
  parseEmailTemplatesPage,
  savedCopy,
  sendingNow,
} from "./email-templates";

/**
 * The parsers are exercised against PLATFORM-API'S OWN COMMITTED GOLDENS, not
 * against fixtures written here.
 *
 * A hand-written fixture asserts what this file believes the producer sends,
 * which is exactly the belief that was wrong in #421 — a parser and its
 * fixture agreed with each other and disagreed with the Go handler, and every
 * test passed while production 500'd. Reading the goldens means a producer
 * change that alters the shape turns this suite red instead.
 *
 * The goldens are the whole envelope; `platformRequest` strips it, so what the
 * parsers see is `golden.data`.
 */
const TESTDATA = join(
  __dirname,
  "../../../platform-api/internal/modules/emailtemplates/internal/handler/testdata",
);

function golden(name: string): { success: boolean; data?: unknown; error?: unknown } {
  return JSON.parse(readFileSync(join(TESTDATA, name), "utf8"));
}

describe("the goldens are where this test thinks they are", () => {
  // Vacuity guard: a moved directory would make every row below throw at
  // read time rather than silently pass, but a wrong-but-readable path would
  // not. Assert one known field.
  it("reads the listing golden", () => {
    expect(golden("list.json").success).toBe(true);
  });
});

describe("parseEmailTemplatesPage", () => {
  const page = parseEmailTemplatesPage(golden("list.json").data);

  it("reads every row the producer sends", () => {
    expect(page.templates.map((row) => row.id)).toEqual([
      "mark8ly:dunning_day_5",
      "mark8ly:giftcard_delivery",
      "mark8ly:orderdoc_invoice",
    ]);
    expect(page.failures).toEqual([]);
  });

  it("keeps state and sends_from as two separate fields", () => {
    // The pair the whole surface turns on. `giftcard_delivery` is a DRAFT that
    // sends the EMBEDDED default; collapsing these into one status is the
    // mistake mark8ly#717 exists to prevent.
    const draft = page.templates.find((row) => row.key === "giftcard_delivery");
    expect(draft?.state).toBe("draft");
    expect(draft?.sends_from).toBe("embedded");
  });

  it("leaves version and updated_by absent rather than zeroed for an unauthored key", () => {
    const unauthored = page.templates.find((row) => row.key === "dunning_day_5");
    expect(unauthored?.state).toBe("unauthored");
    expect(unauthored?.version).toBeUndefined();
    expect(unauthored?.updated_at).toBeUndefined();
    expect(unauthored?.updated_by).toBeUndefined();
  });

  it("carries a failed source rather than reporting an empty registry", () => {
    // The golden that separates "nothing here" from "the read failed": a 200
    // with no rows and a non-empty `failures`.
    const failed = parseEmailTemplatesPage(golden("list-source-failed.json").data);
    expect(failed.templates).toEqual([]);
    expect(failed.failures).toEqual([{ source: "mark8ly", message: "responded 500" }]);
  });

  it("refuses a payload with no failures field", () => {
    // Never nil on the wire. If a producer change ever dropped it, an assumed
    // `[]` would turn a partial listing into a complete-looking one in
    // silence — so this must be a decode failure.
    expect(() => parseEmailTemplatesPage({ templates: [] })).toThrow(/failures/);
  });

  it("refuses a sends_from it does not recognise", () => {
    // Defaulting would state, in a column an operator trusts, which copy is
    // reaching customers — on the strength of a guess.
    expect(() =>
      parseEmailTemplatesPage({
        templates: [
          {
            id: "mark8ly:x",
            source: "mark8ly",
            key: "x",
            state: "published",
            sends_from: "somewhere",
            has_embedded_default: true,
            subject: "s",
          },
        ],
        failures: [],
      }),
    ).toThrow(/sends_from/);
  });
});

describe("parseEmailTemplateDetail", () => {
  it("reads the bodies and the declared variables", () => {
    const detail = parseEmailTemplateDetail(golden("detail.json").data);
    expect(detail.id).toBe("mark8ly:orderdoc_invoice");
    expect(detail.html_body).toBe("<p>{{.OrderNumber}}</p>");
    expect(detail.text_body).toBe("{{.OrderNumber}}");
    expect(detail.variables).toEqual([
      { name: "OrderNumber", type: "string", required: true },
    ]);
  });

  it("reads the save response with the same parser", () => {
    // `saved.json` is the PUT's reply and is the same shape as the read, which
    // is why one parser serves both. If the producer ever diverges them, this
    // row is what says so.
    expect(parseEmailTemplateDetail(golden("saved.json").data).id).toBe(
      "mark8ly:orderdoc_invoice",
    );
  });
});

describe("sendingNow and savedCopy answer different questions", () => {
  it("distinguishes a draft from a never-edited key that send the same thing", () => {
    const draft = { state: "draft", sends_from: "embedded", has_embedded_default: true } as const;
    const unauthored = {
      state: "unauthored",
      sends_from: "embedded",
      has_embedded_default: true,
    } as const;

    // THE POINT OF THE SURFACE: the live answer is identical and the stored
    // answer is not. A single badge would render these two rows the same.
    expect(sendingNow(draft)).toEqual(sendingNow(unauthored));
    expect(savedCopy(draft).label).not.toEqual(savedCopy(unauthored).label);
  });

  it("says a draft is not sending, in the label rather than only in prose", () => {
    expect(savedCopy({ state: "draft" }).label).toMatch(/not sending/i);
  });

  it("explains a key that sends nothing at all differently from one that is merely idle", () => {
    const noDefault = sendingNow({ sends_from: "nothing", has_embedded_default: false });
    const withDefault = sendingNow({ sends_from: "nothing", has_embedded_default: true });
    expect(noDefault.detail).not.toEqual(withDefault.detail);
    expect(noDefault.detail).toMatch(/no built-in default/i);
  });

  it("warns that a draft changes nothing customers receive", () => {
    expect(DRAFT_DOES_NOT_SEND).toMatch(/keeps sending/i);
  });
});

describe("the coverage gap is named key by key", () => {
  it("lists every auth template federation does not reach", () => {
    // Named individually rather than described. An operator who searches for
    // `password_reset`, finds nothing and concludes it does not exist has been
    // misled by omission, and a vague disclaimer does not fix that.
    expect([...UNREACHABLE_AUTH_KEYS].sort()).toEqual([
      "email_verification",
      "invitation",
      "login_otp",
      "new_device_login",
      "password_reset",
      "welcome",
    ]);
  });
});

describe("failureSentence", () => {
  it("names the source and what it said", () => {
    expect(failureSentence([{ source: "mark8ly", message: "responded 500" }])).toBe(
      "mark8ly could not be read (responded 500).",
    );
  });
});

describe("emailTemplateFailureMessage", () => {
  /** As `unwrapEnvelope` builds it: code carried structurally, status beside. */
  function refusal(name: string, status: number) {
    const error = golden(name).error as { code: string; message: string };
    return Object.assign(new Error(error.message), { status, code: error.code });
  }

  it("gives each golden refusal its own sentence", () => {
    // Every one of these is a different next step for an operator, and two of
    // them share a status — which is why the code is carried on the error.
    const sentences = [
      emailTemplateFailureMessage("test-send", refusal("error-not-configured.json", 501)),
      emailTemplateFailureMessage("save", refusal("error-invalid-template.json", 422)),
      emailTemplateFailureMessage("test-send", refusal("error-send-failed.json", 503)),
      emailTemplateFailureMessage("save", refusal("error-unknown-key.json", 404)),
      emailTemplateFailureMessage("save", refusal("error-no-idempotency-key.json", 400)),
    ];
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("says nothing is broken for NOT_IMPLEMENTED", () => {
    expect(
      emailTemplateFailureMessage("list", refusal("error-not-instrumented.json", 501)),
    ).toMatch(/configuration state, not an outage/i);
  });

  it("separates a product that answered from one that was never reached", () => {
    // Both are 503. `EXTERNAL_SERVICE_ERROR` says go and look at mark8ly;
    // `SERVICE_UNAVAILABLE` says retry. The status cannot tell them apart.
    const answered = emailTemplateFailureMessage(
      "save",
      Object.assign(new Error("x"), { status: 503, code: "EXTERNAL_SERVICE_ERROR" }),
    );
    const unreachable = emailTemplateFailureMessage(
      "save",
      Object.assign(new Error("x"), { status: 503, code: "SERVICE_UNAVAILABLE" }),
    );
    expect(answered).not.toEqual(unreachable);
    expect(answered).toMatch(/check the product/i);
    expect(unreachable).toMatch(/retry/i);
  });

  it("names the missing idempotency key as a console bug, not a retryable failure", () => {
    const message = emailTemplateFailureMessage(
      "save",
      refusal("error-no-idempotency-key.json", 400),
    );
    expect(message).toMatch(/Idempotency-Key/);
    expect(message).toMatch(/retrying will not help/i);
  });

  it("falls back to a per-verb sentence for a code it has never seen", () => {
    const message = emailTemplateFailureMessage(
      "test-send",
      Object.assign(new Error("x"), { status: 503, code: "SOMETHING_NEW" }),
    );
    expect(message).toMatch(/No message was sent/);
  });

  it("never renders the upstream message", () => {
    // Free text from another product, and for a transport failure it carries
    // hostnames — which is why federation sanitises at all.
    const message = emailTemplateFailureMessage(
      "save",
      Object.assign(new Error("dial tcp 10.4.0.7:8080: i/o timeout"), {
        status: 503,
        code: "SERVICE_UNAVAILABLE",
      }),
    );
    expect(message).not.toMatch(/10\.4\.0\.7/);
  });
});
