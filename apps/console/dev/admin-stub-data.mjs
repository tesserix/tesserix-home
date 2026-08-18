// Fixtures for the admin API stub. Separated from the server so the
// verification test can import them without starting a listener.
//
// SHAPES ARE snake_case, matching what apps/web actually returns on the wire —
// not the camelCase types the console parses them into. Getting that backwards
// produces a stub that satisfies TypeScript and fails every parser, which is
// the failure this file's sibling test exists to catch.

// A fixed instant, so a rendered page says the same thing on every run and an
// e2e assertion can name a value. `new Date()` here would make timestamps
// drift between the fixture and the assertion.
const T0 = Date.parse("2026-08-18T09:00:00.000Z");
const at = (minutesAgo) => new Date(T0 - minutesAgo * 60_000).toISOString();

export const TICKETS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    product_id: "mark8ly",
    tenant_id: "amber-collective",
    ticket_number: "MK-1041",
    subject: "Checkout fails on the storefront",
    description:
      "Customers see a 500 at the payment step. Started after this morning's deploy.",
    status: "open",
    priority: "urgent",
    submitted_by_name: "Amber Collective",
    submitted_by_email: "owner@amber.test",
    resolved_at: null,
    created_at: at(90),
    updated_at: at(30),
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    product_id: "mark8ly",
    tenant_id: "basil-studio",
    ticket_number: "MK-1040",
    subject: "Cannot upload product images above 2MB",
    description: "Upload spins and then fails silently.",
    status: "in_progress",
    priority: "high",
    submitted_by_name: "Basil Studio",
    submitted_by_email: "hello@basil.test",
    resolved_at: null,
    created_at: at(240),
    updated_at: at(60),
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    product_id: "kora",
    tenant_id: "cedar-works",
    ticket_number: "KO-207",
    subject: "Export produces an empty CSV",
    description: "The file downloads but has only a header row.",
    status: "open",
    priority: "medium",
    submitted_by_name: "Cedar Works",
    submitted_by_email: "ops@cedar.test",
    resolved_at: null,
    created_at: at(600),
    updated_at: at(600),
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    product_id: "dwellm8",
    tenant_id: "dune-house",
    ticket_number: "DW-88",
    subject: "Tenant invite email never arrives",
    description: "Resent three times, nothing in spam either.",
    status: "resolved",
    priority: "low",
    submitted_by_name: "Dune House",
    submitted_by_email: "admin@dune.test",
    resolved_at: at(120),
    created_at: at(2880),
    updated_at: at(120),
  },
];

export const REPLIES = {
  "11111111-1111-4111-8111-111111111111": [
    {
      id: "aaaaaaa1-1111-4111-8111-aaaaaaaaaaa1",
      author_type: "merchant",
      author_name: "Amber Collective",
      author_email: "owner@amber.test",
      content: "This is blocking every order. Can someone look now?",
      created_at: at(88),
    },
    {
      id: "aaaaaaa2-2222-4222-8222-aaaaaaaaaaa2",
      author_type: "platform_admin",
      author_name: "Mahesh",
      author_email: "mahesh@tesserix.test",
      content: "Looking into it — we can see the 500s in the payment logs.",
      created_at: at(30),
    },
  ],
};

// The dashboard payload, exactly as ADR-003 and #269 describe it: one screen's
// object spanning four unrelated domains. Reproduced faithfully rather than
// tidied up, because the stub's job is to stand in for what exists — the
// tidying is the platform API's job, not this file's.
export const DASHBOARD = {
  tenants: { total: 42, active: 37 },
  stores: { total: 51 },
  leads: {
    total: 140,
    by_status: { new: 65, contacted: 39, qualified: 24, converted: 9, lost: 10 },
  },
  apps: { active: 4 },
  generated_at: new Date(T0).toISOString(),
};

export const SUPPORT_ANALYTICS = {
  total: 128,
  open: 17,
  escalated: 6,
  ai_resolved: 74,
  avg_resolution_seconds: 7380,
  csat: 4.3,
  resolved_rate: 0.82,
  feedback_count: 61,
  by_status: { open: 17, in_progress: 11, resolved: 96, closed: 4 },
  by_reason: { billing: 34, bug: 41, "how-to": 28, other: 9 },
  by_tenant: {
    "amber-collective": 22,
    "basil-studio": 18,
    "cedar-works": 12,
    "dune-house": 7,
  },
  tenant_names: {
    "amber-collective": "Amber Collective",
    "basil-studio": "Basil Studio",
    "cedar-works": "Cedar Works",
    "dune-house": "Dune House",
  },
};

export const AUDIT_ENTRIES = [
  {
    source: "mark8ly",
    id: "mark8ly:9001",
    actor: "mahesh@tesserix.test",
    action: "tenant.suspended",
    target: "basil-studio",
    timestamp: at(15),
    metadata: JSON.stringify({ reason: "payment failed" }),
  },
  {
    source: "console",
    id: "console:412",
    actor: "mahesh@tesserix.test",
    action: "crm.contact.updated",
    target: "Amber Collective",
    timestamp: at(45),
    metadata: null,
  },
  {
    source: "kora",
    id: "kora:77",
    actor: "system",
    action: "user.invited",
    target: "ops@cedar.test",
    timestamp: at(180),
    metadata: null,
  },
];

// A populated `failures` array on a 200, deliberately.
//
// The endpoint's partial-failure semantics are the interesting case and the
// one the console has real handling for: some sources answered, one did not.
// A stub that always returned an empty array would leave that path unrendered
// locally — which is exactly the gap #271 exists to close.
export const AUDIT_FAILURES = [
  { source: "dwellm8", message: "audit endpoint not configured" },
];
