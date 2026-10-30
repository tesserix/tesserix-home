import { webcrypto } from "node:crypto";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StaffIdentityRecoveryRequestReceipt } from "@/lib/provisioning/generated/staff-recovery";
import { StaffRecovery } from "./StaffRecovery";

const tenant = "019a3c26-1234-7123-8123-123456789abc";
const command = "019a3c26-1234-7123-8123-123456789abd";
const request = "019a3c26-1234-7123-8123-123456789abe";
const scope = { tenantId: tenant, commandId: command, requestId: request };
const operator = {
  subject: "reviewer",
  sessionKey: "fixture-reviewer-session",
  canWrite: true,
};
const base = `/api/onboarding/orgs/${tenant}/staff-identities/${command}/recovery`;
const record: StaffIdentityRecoveryRequestReceipt = {
  schema_version: 1,
  tenant_id: tenant,
  command_id: command,
  request_id: request,
  requested_by: "maker",
  requested_action: "close_unresolved",
  reason: "Investigated uncertain creation",
  evidence_reference: "QA:REVIEW/123",
  recorded_at: "2026-10-31T08:00:00Z",
};
const fetcher = vi.fn();
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === base && !options?.method?.match(/POST|PUT/))
      return Response.json({
        schema_version: 1,
        tenant_id: tenant,
        command_id: command,
        product_key: "helivanta",
        actor_subject: "initiator",
        command_state: "dispatched",
        prepared_at: "2026-10-31T07:00:00Z",
      });
    if (path === `${base}/requests/${request}` && options?.method !== "PUT")
      return Response.json(record);
    if (path === `${base}/observations`)
      return Response.json({
        schema_version: 1,
        tenant_id: tenant,
        command_id: command,
        source_disposition: "absent",
        observed_at: "2026-10-31T08:01:00Z",
      });
    return Response.json(
      { detail: "Unavailable fixture route" },
      { status: 503 },
    );
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows exact retained evidence and a fresh source observation without claiming access", async () => {
  render(<StaffRecovery initialScope={scope} operator={operator} />);
  expect(await screen.findByText(record.reason)).toBeInTheDocument();
  expect(screen.getByText(record.evidence_reference)).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Check current source" }),
  );
  expect(await screen.findByText("absent")).toBeInTheDocument();
  expect(screen.getByText("2026-10-31T08:01:00Z")).toBeInTheDocument();
  expect(
    screen.getByText(/does not grant membership or hospital access/i),
  ).toBeInTheDocument();
  const [, init] = fetcher.mock.calls.find(
    ([path]) => path === `${base}/observations`,
  )!;
  expect(init.method).toBe("POST");
  expect(init.body).toBeUndefined();
});

it("freezes an uncertain independent decision and retries the same body and key", async () => {
  let writes = 0;
  const read = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === `${base}/requests/${request}/decision`) {
      writes++;
      if (writes === 1)
        return Response.json(
          { detail: "The result could not be confirmed" },
          { status: 503 },
        );
      return Response.json({
        ...record,
        decision: {
          decision: "approved",
          reviewed_by: "reviewer",
          reason: "Independently verified source",
          recorded_at: "2026-10-31T08:02:00Z",
        },
      });
    }
    return read(path, options);
  });
  render(<StaffRecovery initialScope={scope} operator={operator} />);
  const reason = await screen.findByLabelText("Review reason");
  await userEvent.type(reason, "Independently verified source");
  await userEvent.click(
    screen.getByLabelText(
      "I have independently reviewed the retained evidence",
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Record independent decision" }),
  );
  expect(
    await screen.findByText("The result could not be confirmed"),
  ).toBeInTheDocument();
  expect(reason).toBeDisabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Retry same decision" }),
  );
  await waitFor(() => expect(writes).toBe(2));
  const calls = fetcher.mock.calls.filter(
    ([path]) => path === `${base}/requests/${request}/decision`,
  );
  expect(calls[0][1].body).toBe(calls[1][1].body);
  expect(new Headers(calls[0][1].headers).get("idempotency-key")).toBe(
    new Headers(calls[1][1].headers).get("idempotency-key"),
  );
  expect(JSON.parse(calls[0][1].body)).toEqual({
    decision: "approved",
    reason: "Independently verified source",
  });
  expect(calls[0][1].method).toBe("PUT");
  expect(
    await screen.findByText("Decision retained by the identity owner."),
  ).toBeInTheDocument();
});

it("does not disclose a mismatched request or render a reviewer write for readers or makers", async () => {
  const read = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (path: string, options?: RequestInit) =>
    path === `${base}/requests/${request}`
      ? Response.json({
          ...record,
          tenant_id: "019a3c26-1234-7123-8123-123456789aff",
          reason: "PRIVATE FOREIGN REASON",
        })
      : read(path, options),
  );
  const mounted = render(
    <StaffRecovery initialScope={scope} operator={operator} />,
  );
  expect(
    await screen.findByText(/returned evidence did not match/),
  ).toBeInTheDocument();
  expect(screen.queryByText("PRIVATE FOREIGN REASON")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Record independent decision" }),
  ).not.toBeInTheDocument();
  fetcher.mockImplementation(read);
  mounted.rerender(
    <StaffRecovery
      initialScope={scope}
      operator={{ ...operator, sessionKey: "reader-session", canWrite: false }}
    />,
  );
  expect(await screen.findByText(record.reason)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Record independent decision" }),
  ).not.toBeInTheDocument();
  mounted.rerender(
    <StaffRecovery
      initialScope={scope}
      operator={{ ...operator, subject: "maker", sessionKey: "maker-session" }}
    />,
  );
  expect(
    await screen.findByText(
      "An independent operator must review this request.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Record independent decision" }),
  ).not.toBeInTheDocument();
});

it("resumes an uncertain decision after reload without persisting its private reason", async () => {
  const read = fetcher.getMockImplementation()!;
  const writes: RequestInit[] = [];
  fetcher.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === `${base}/requests/${request}/decision`) {
      writes.push(options!);
      return Response.json({ detail: "Unconfirmed outcome" }, { status: 503 });
    }
    return read(path, options);
  });
  const first = render(
    <StaffRecovery initialScope={scope} operator={operator} />,
  );
  await userEvent.type(
    await screen.findByLabelText("Review reason"),
    "PRIVATE ORIGINAL REASON",
  );
  await userEvent.click(
    screen.getByLabelText(
      "I have independently reviewed the retained evidence",
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Record independent decision" }),
  );
  expect(await screen.findByText("Unconfirmed outcome")).toBeInTheDocument();
  expect(sessionStorage.length).toBe(1);
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).not.toContain(
    "PRIVATE ORIGINAL REASON",
  );
  first.unmount();
  render(<StaffRecovery initialScope={scope} operator={operator} />);
  const reason = await screen.findByLabelText("Review reason");
  await waitFor(() =>
    expect(screen.getByText(/Unconfirmed decision/)).toBeInTheDocument(),
  );
  await userEvent.type(reason, "Changed private reason");
  await userEvent.click(
    screen.getByLabelText(
      "I have independently reviewed the retained evidence",
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Record independent decision" }),
  );
  expect(
    await screen.findByText(/Re-enter the original decision and reason/),
  ).toBeInTheDocument();
  expect(writes).toHaveLength(1);
  await userEvent.clear(reason);
  await userEvent.type(reason, "PRIVATE ORIGINAL REASON");
  await userEvent.click(
    screen.getByRole("button", { name: "Record independent decision" }),
  );
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[0].body).toBe(writes[1].body);
  expect(new Headers(writes[0].headers).get("idempotency-key")).toBe(
    new Headers(writes[1].headers).get("idempotency-key"),
  );
});

it("records a proposal with a stable UUIDv7 and preserves an uncertain retry", async () => {
  const writes: Array<{ path: string; options: RequestInit }> = [];
  const read = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path.startsWith(`${base}/requests/`)) {
      const requestId = path.split("/").at(-1)!;
      if (options?.method === "PUT") {
        writes.push({ path, options });
        if (writes.length === 1)
          return Response.json(
            { detail: "Unconfirmed proposal" },
            { status: 503 },
          );
        return Response.json({
          schema_version: 1,
          tenant_id: tenant,
          command_id: command,
          request_id: requestId,
          requested_action: "close_unresolved",
          recorded_at: record.recorded_at,
        });
      }
      if (writes.length < 2)
        return Response.json(
          { detail: "No retained request" },
          { status: 404 },
        );
      return Response.json({
        ...record,
        request_id: requestId,
        requested_by: operator.subject,
      });
    }
    return read(path, options);
  });
  render(
    <StaffRecovery
      initialScope={{ tenantId: tenant, commandId: command }}
      operator={operator}
    />,
  );
  await userEvent.type(
    await screen.findByLabelText("Proposal reason"),
    record.reason,
  );
  await userEvent.type(
    screen.getByLabelText("Evidence reference"),
    record.evidence_reference,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Record recovery request" }),
  );
  expect(await screen.findByText("Unconfirmed proposal")).toBeInTheDocument();
  expect(screen.getByLabelText("Proposal reason")).toBeDisabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Retry same proposal" }),
  );
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[0].path).toBe(writes[1].path);
  expect(writes[0].path).toMatch(
    /\/requests\/[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(writes[0].options.body).toBe(writes[1].options.body);
  expect(new Headers(writes[0].options.headers).get("idempotency-key")).toBe(
    new Headers(writes[1].options.headers).get("idempotency-key"),
  );
  expect(JSON.parse(writes[0].options.body as string)).toEqual({
    requested_action: "close_unresolved",
    reason: record.reason,
    evidence_reference: record.evidence_reference,
  });
  expect(
    await screen.findByText(
      "Recovery request retained. A different operator must review it.",
    ),
  ).toBeInTheDocument();
});

it("reconciles a matching source only through the write-authorized owner path", async () => {
  const read = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === `${base}/observations`)
      return Response.json({
        schema_version: 1,
        tenant_id: tenant,
        command_id: command,
        source_disposition: "matching",
        observed_at: "2026-10-31T08:01:00Z",
      });
    if (path === `${base}/reconciliations`)
      return Response.json({
        schema_version: 1,
        tenant_id: tenant,
        command_id: command,
        product_key: "helivanta",
        actor_subject: "initiator",
        command_state: "created",
        prepared_at: "2026-10-31T07:00:00Z",
        created_at: "2026-10-31T07:05:00Z",
        user_id: "synthetic-source-account",
      });
    return read(path, options);
  });
  render(<StaffRecovery initialScope={scope} operator={operator} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Check current source" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Reconcile matching creation" }),
  );
  expect(
    await screen.findByText(
      "Original creation evidence retained. No account or membership was created.",
    ),
  ).toBeInTheDocument();
  const [, options] = fetcher.mock.calls.find(
    ([path]) => path === `${base}/reconciliations`,
  )!;
  expect(options.method).toBe("POST");
  expect(options.body).toBeUndefined();
});

it("hides retained private evidence after an operator write is denied and current reads are revoked", async () => {
  const read = fetcher.getMockImplementation()!;
  let revoked = false;
  fetcher.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === `${base}/requests/${request}/decision`) {
      revoked = true;
      return Response.json(
        { detail: "Additional permission required" },
        { status: 403 },
      );
    }
    if (revoked && (path === base || path === `${base}/requests/${request}`))
      return Response.json({ detail: "Not found" }, { status: 404 });
    return read(path, options);
  });
  render(<StaffRecovery initialScope={scope} operator={operator} />);
  await userEvent.type(
    await screen.findByLabelText("Review reason"),
    "Independent review before withdrawal",
  );
  await userEvent.click(
    screen.getByLabelText(
      "I have independently reviewed the retained evidence",
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Record independent decision" }),
  );
  await waitFor(() =>
    expect(screen.queryByText(record.reason)).not.toBeInTheDocument(),
  );
  expect(screen.queryByLabelText("Review reason")).not.toBeInTheDocument();
  expect(sessionStorage.length).toBe(1);
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).not.toContain(
    "Independent review before withdrawal",
  );
});

it("confirms a retained decision after response loss without sending another write", async () => {
  const read = fetcher.getMockImplementation()!;
  let committed = false;
  let writes = 0;
  const decision = {
    decision: "approved",
    reviewed_by: operator.subject,
    reason: "Confirmed independent review",
    recorded_at: "2026-10-31T08:02:00Z",
  };
  fetcher.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === `${base}/requests/${request}/decision`) {
      writes++;
      committed = true;
      return Response.json({ detail: "Response lost" }, { status: 503 });
    }
    if (path === `${base}/requests/${request}` && committed)
      return Response.json({ ...record, decision });
    return read(path, options);
  });
  render(<StaffRecovery initialScope={scope} operator={operator} />);
  await userEvent.type(
    await screen.findByLabelText("Review reason"),
    decision.reason,
  );
  await userEvent.click(
    screen.getByLabelText(
      "I have independently reviewed the retained evidence",
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Record independent decision" }),
  );
  expect(await screen.findByText("Response lost")).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh retained request" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Confirm retained decision" }),
  );
  expect(
    await screen.findByText("Decision retained by the identity owner."),
  ).toBeInTheDocument();
  expect(writes).toBe(1);
  expect(sessionStorage.length).toBe(0);
});

it("retains the same prepared replacement command across reload and uncertain retry", async () => {
  const read = fetcher.getMockImplementation()!;
  const writes: RequestInit[] = [];
  fetcher.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === `${base}/requests/${request}/decision`) {
      writes.push(options!);
      return Response.json(
        { detail: "Replacement outcome unconfirmed" },
        { status: 503 },
      );
    }
    if (path === `${base}/requests/${request}`)
      return Response.json({
        ...record,
        requested_action: "replace",
        replacement_actor_subject: "new-initiator",
      });
    return read(path, options);
  });
  const first = render(
    <StaffRecovery initialScope={scope} operator={operator} />,
  );
  await userEvent.type(
    await screen.findByLabelText("Review reason"),
    "Independent replacement approval",
  );
  await userEvent.click(
    screen.getByLabelText(
      "I have independently reviewed the retained evidence",
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Record independent decision" }),
  );
  expect(
    await screen.findByText("Replacement outcome unconfirmed"),
  ).toBeInTheDocument();
  const original = JSON.parse(writes[0].body as string);
  expect(original.successor_command_id).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  first.unmount();
  render(<StaffRecovery initialScope={scope} operator={operator} />);
  const reason = await screen.findByLabelText("Review reason");
  await waitFor(() =>
    expect(screen.getByText(/Unconfirmed decision/)).toBeInTheDocument(),
  );
  await userEvent.type(reason, "Independent replacement approval");
  await userEvent.click(
    screen.getByLabelText(
      "I have independently reviewed the retained evidence",
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Record independent decision" }),
  );
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(JSON.parse(writes[1].body as string)).toEqual(original);
  expect(new Headers(writes[0].headers).get("idempotency-key")).toBe(
    new Headers(writes[1].headers).get("idempotency-key"),
  );
});

it("clears a prior matching observation when its next proof is unavailable", async () => {
  const read = fetcher.getMockImplementation()!;
  let observations = 0;
  fetcher.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === `${base}/observations`) {
      observations++;
      return observations === 1
        ? Response.json({
            schema_version: 1,
            tenant_id: tenant,
            command_id: command,
            source_disposition: "matching",
            observed_at: "2026-10-31T08:01:00Z",
          })
        : Response.json(
            { detail: "Current source unavailable" },
            { status: 503 },
          );
    }
    return read(path, options);
  });
  render(<StaffRecovery initialScope={scope} operator={operator} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Check current source" }),
  );
  expect(
    await screen.findByRole("button", { name: "Reconcile matching creation" }),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Check current source" }),
  );
  expect(
    await screen.findByText("Current source unavailable"),
  ).toBeInTheDocument();
  expect(screen.queryByText("matching")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Reconcile matching creation" }),
  ).not.toBeInTheDocument();
});
