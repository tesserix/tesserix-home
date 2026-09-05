import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { EmailTemplateRow } from "@/lib/email-templates";
import { EmailTemplatesView } from "./email-templates-view";

const PUBLISHED: EmailTemplateRow = {
  id: "mark8ly:orderdoc_invoice",
  source: "mark8ly",
  key: "orderdoc_invoice",
  state: "published",
  sends_from: "row",
  has_embedded_default: true,
  subject: "Order {{.OrderNumber}}",
  version: 3,
  updated_at: "2026-08-01T09:30:00Z",
  updated_by: "op_previous",
};

const DRAFT: EmailTemplateRow = {
  id: "mark8ly:giftcard_delivery",
  source: "mark8ly",
  key: "giftcard_delivery",
  state: "draft",
  sends_from: "embedded",
  has_embedded_default: true,
  subject: "Your gift card from {{.StoreName}}",
  version: 7,
  updated_at: "2026-08-20T16:45:00Z",
};

const UNAUTHORED: EmailTemplateRow = {
  id: "mark8ly:dunning_day_5",
  source: "mark8ly",
  key: "dunning_day_5",
  state: "unauthored",
  sends_from: "embedded",
  has_embedded_default: true,
  subject: "Payment failed for {{.StoreName}}",
};

function renderView(props: Partial<Parameters<typeof EmailTemplatesView>[0]> = {}) {
  render(
    <EmailTemplatesView
      rows={[PUBLISHED, DRAFT, UNAUTHORED]}
      failures={[]}
      state={{ kind: "ready" }}
      emptyMessage="Nothing registered."
      {...props}
    />,
  );
}

describe("the draft and the never-edited row are told apart", () => {
  it("shows both as sending the built-in default", () => {
    renderView();
    // Two rows send the embedded default, and the third does not. If the two
    // ever stop agreeing here, the live column has started reading `state`.
    expect(screen.getAllByText("Built-in default")).toHaveLength(2);
    expect(screen.getByText("Your saved copy")).toBeInTheDocument();
  });

  it("shows a different stored state for each of them", () => {
    renderView();
    // The distinction a single status badge would destroy. A draft is work in
    // progress that is NOT live; a never-edited key has simply never been
    // touched. Both send the default, for different reasons.
    expect(screen.getByText("Draft — not sending")).toBeInTheDocument();
    expect(screen.getByText("Never edited")).toBeInTheDocument();
    expect(screen.getByText("Published")).toBeInTheDocument();
  });

  it("renders no version for an unauthored key rather than v0", () => {
    renderView({ rows: [UNAUTHORED] });
    // Two em dashes, not one: Version and Last saved are both absent for a key
    // nobody has authored, because the producer omits the keys rather than
    // zeroing them. A `v0` beside a template that sends perfectly well reads as
    // a broken row.
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("v0")).not.toBeInTheDocument();
  });

  it("links each row to its editor by the namespaced id", () => {
    renderView({ rows: [PUBLISHED] });
    expect(screen.getByRole("link", { name: "orderdoc_invoice" })).toHaveAttribute(
      "href",
      "/mark8ly/email-templates/mark8ly%3Aorderdoc_invoice",
    );
  });
});

describe("a partial listing says so", () => {
  it("warns when some rows arrived and a source failed", () => {
    // The mixed case: a 200 carrying rows AND failures. Without this the table
    // reads as the whole registry, which is the failure `data.failures[]`
    // exists to make visible.
    renderView({ failures: [{ source: "mark8ly", message: "responded 500" }] });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This list is incomplete");
    expect(alert).toHaveTextContent("mark8ly could not be read (responded 500).");
    expect(alert).toHaveTextContent("missing from the table below, not absent");
  });

  it("says nothing when every source answered", () => {
    renderView();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("the page states what it does not cover", () => {
  it("names each auth key that is not reachable here", () => {
    renderView();
    // Named individually. An operator who searches for `password_reset`, finds
    // nothing and concludes it does not exist has been misled by omission.
    for (const key of [
      "welcome",
      "email_verification",
      "invitation",
      "password_reset",
      "login_otp",
      "new_device_login",
    ]) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
  });

  it("does not link apps/web", () => {
    // `mark8ly.emailTemplates` records that path, and `pending`'s rule binds
    // renderers: apps/web reaches these rows over the cross-database write
    // path this surface exists to stop using. Naming it is right; linking it
    // is not.
    renderView();
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/^\/admin\//);
    }
  });
});
