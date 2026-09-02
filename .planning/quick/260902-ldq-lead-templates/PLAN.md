---
quick_id: 260902-ldq
slug: lead-templates
branch: feat/crm-lead-templates
phase: quick-260902-ldq-lead-templates
plan: 01
wave: 1
depends_on: []
type: execute
autonomous: false
requirements: [LDQ-01, LDQ-02, LDQ-03, LDQ-04, LDQ-05]
files_modified:
  - apps/web/db/migrations/0043_crm_templates.sql
  - apps/console/lib/crm-merge-fields.ts
  - apps/console/lib/crm-merge-fields.test.ts
  - apps/console/lib/db/crm-templates.ts
  - apps/console/lib/db/crm-templates.integration.test.ts
  - apps/console/lib/db/crm-templates-schema.integration.test.ts
  - apps/console/lib/db/crm-outreach.ts
  - apps/console/lib/db/crm-outreach.integration.test.ts
  - apps/console/lib/db/crm-repo.ts
  - apps/console/app/(console)/platform/crm/templates/page.tsx
  - apps/console/app/(console)/platform/crm/templates/actions.ts
  - apps/console/app/(console)/platform/crm/templates/actions.test.ts
  - apps/console/app/(console)/platform/crm/templates/page.test.tsx
  - apps/console/app/(console)/platform/crm/templates/templates-view.tsx
  - apps/console/app/(console)/platform/crm/[organisation]/actions.ts
  - apps/console/app/(console)/platform/crm/[organisation]/actions.templates.test.ts
  - apps/console/app/(console)/platform/crm/[organisation]/template-composer.tsx
  - apps/console/app/(console)/platform/crm/[organisation]/template-composer.render.test.tsx
  - apps/console/app/(console)/platform/crm/[organisation]/organisation-detail-view.tsx
  - apps/console/app/(console)/platform/crm/[organisation]/page.tsx
  - packages/console-core/src/routes.ts
  - packages/console-core/src/nav.ts
  - packages/console-core/src/nav.test.ts

must_haves:
  truths:
    - "An operator can author a DM or email template with merge fields and archive it without a deploy."
    - "Opening a lead's composer with a template selected shows the fully rendered message, or refuses and names what is missing."
    - "A template referencing a field that is null for this lead produces NO text at all — the copy control is disabled and the missing field is named."
    - "A lead whose email or Instagram handle is on the do-not-contact list is refused at preview, before any text is produced."
    - "One click copies the message and logs a dm_sent activity, sets a 4-day next action, moves the drift clock and moves stage new → contacted."
    - "The rendered body — which embeds scraped biography text — is NEVER persisted to crm_activities. Only template_id and rendered_at are."
  artifacts:
    - path: "apps/web/db/migrations/0043_crm_templates.sql"
      provides: "crm_templates table + crm_template_channel enum"
      contains: "CREATE TABLE crm_templates"
    - path: "apps/console/lib/crm-merge-fields.ts"
      provides: "Merge-field registry and all-or-nothing renderer"
      exports: ["MERGE_FIELDS", "parseMergeFields", "renderTemplate"]
    - path: "apps/console/lib/db/crm-templates.ts"
      provides: "Template CRUD + per-lead merge-field context read"
      exports: ["listTemplates", "createTemplate", "archiveTemplate", "templateContext"]
    - path: "apps/console/lib/db/crm-outreach.ts"
      provides: "The single transaction behind copy-and-log"
      exports: ["recordTemplatedDm"]
    - path: "apps/console/lib/db/crm-outreach.integration.test.ts"
      provides: "The constraint-2 proof: no scrape-derived text in crm_activities"
  key_links:
    - from: "apps/console/app/(console)/platform/crm/[organisation]/template-composer.tsx"
      to: "previewTemplate / copyAndLogDm"
      via: "server actions"
      pattern: "previewTemplate|copyAndLogDm"
    - from: "apps/console/lib/db/crm-outreach.ts"
      to: "assertNoSuppressedContact + advanceStageOnQuery"
      via: "one tesserixTx client"
      pattern: "assertNoSuppressedContact|advanceStageOnQuery"
---

<objective>
Ship the CRM lead-template composer so the 259 stage-`new` Mark8ly leads in `/platform/crm`
can be worked without hand-writing every DM.

Purpose: templated outreach at safe manual volume, with the three properties that make it
worth building at all — no empty substitutions, no scraped personal data leaking into a
table erasure does not reach, no message produced for someone who asked us to stop.

Output: one migration, two pure/repo modules, one admin surface, one per-lead composer,
and one adversarial test a reviewer can read on its own.

NOT in scope, and no task may add it: any sending (Instagram has no cold-DM API and
automating DMs gets the account restricted; email sending stays with the ESP), any
test-send (so `mass-send` is never engaged), any bulk or queue mode (safe manual volume is
20–30 DMs/day and identical text at volume is what draws enforcement — the per-lead
editable preview IS the feature, not a v1 limitation).
</objective>

<context>
@apps/web/db/migrations/0019_crm_schema.sql
@apps/web/db/migrations/0027_crm_contacts_metadata.sql
@apps/console/lib/db/crm-erasure.ts
@apps/console/lib/db/crm-repo.ts
@apps/console/lib/db/crm-identity.ts
@apps/console/lib/crm-write.ts
@apps/console/lib/crm.ts
@apps/console/app/(console)/platform/crm/suppressions/actions.ts
@apps/console/app/(console)/platform/crm/suppressions/page.tsx
@apps/console/app/(console)/platform/crm/suppressions/suppressions-view.tsx
@apps/console/app/(console)/platform/crm/[organisation]/activity-composer.tsx
@apps/console/app/(console)/platform/crm/[organisation]/organisation-detail-view.tsx
@apps/console/lib/db/crm-erasure.integration.test.ts
@packages/console-core/src/routes.ts
@packages/console-core/src/routes.console.test.ts
@packages/console-core/src/nav.ts
</context>

<interfaces>
<!-- Extracted from the codebase. The executor should use these directly; no exploration needed. -->

crm_activities (0019) — the table constraint 2 is about:
  id, organisation_id NOT NULL, opportunity_id, contact_id (ON DELETE SET NULL),
  kind crm_activity_kind, actor text NOT NULL, body text, metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()

crm_contacts (0019 + 0024 + 0027) — merge-field sources:
  name, email, phone, instagram_handle, followers_count, posts_count, biography,
  is_primary, source, sourced_at, lawful_basis, erased_at, metadata jsonb

crm_organisations (0019): name NOT NULL, website_url, location, category text[] NOT NULL DEFAULT '{}', tags text[]

From apps/console/lib/db/crm-repo.ts:
  export class SuppressedContactError extends Error {
    constructor(organisationId?: string, message?: string)
  }
  export async function isSuppressed(input: SuppressionCheck, query: TxQuery = tesserixQuery): Promise<boolean>
  export async function advanceStage(input: AdvanceStageInput): Promise<AdvanceStageResult>
  // PRIVATE today, made internal-exported by Task 5:
  async function assertNoSuppressedContact(organisationId: string, query: TxQuery): Promise<void>
  export interface ContactRow { id; name; email; phone; instagramHandle; isPrimary }   // no biography — Task 3 adds a separate read

From apps/console/lib/crm-write.ts:
  export type CrmActionResult = { ok: true } | { ok: false; message: string }
  export async function withCrmWrite<T>(
    target: string,
    options: { capability: Capability },
    run: (actor: { sub: string; email: string }) => Promise<T>,
    describe: (result: T) => AuditDescription,
    mapError?: (cause: unknown) => { ok: false; message: string } | undefined,
  ): Promise<{ ok: true; value: T } | { ok: false; message: string }>

From apps/console/lib/db/audit-repo.ts:
  export interface AuditDescription { action: string; summary: AuditSummary; target?: string }
  // `action` must be a stable dotted identifier (validateActionName). New names used here:
  //   crm.template.create · crm.template.archive · crm.outreach.dm

From apps/console/lib/db/crm-identity.ts:
  export function normalizeContactEmail(email: string): string
  export function normalizeInstagramHandle(handle: string): string

Integration-test harness (copy verbatim from crm-erasure.integration.test.ts):
  PGlite + vi.hoisted dbHolder + vi.mock("./tesserix") delegating tesserixTx to actual.runTesserixTx,
  then `await db.exec(readFileSync(path.resolve(__dirname, "../../../web/db/migrations", file)))`
  for each migration the test's claims actually depend on.
</interfaces>

<tasks>

<task type="checkpoint:decision" gate="blocking">
  <name>Task 0: Which route id this surface ships under</name>
  <decision>
    Whether to un-pend `platform.leadTemplates`, or add a new `platform.crmTemplates`.
  </decision>
  <context>
    The brief says `platform.leadTemplates` is "already reserved… ship it". Reading the
    codebase says that id is already taken by a different thing:

    - `apps/mobile/app/platform/lead-templates.tsx` EXISTS and is live. It renders
      `LeadTemplate { key, label, subject, htmlBody, textBody, variables[], status:
      'published'|'draft', product, version, updatedAt, updatedBy }` from the platform API
      (`GET /lead-templates`, `POST /lead-templates/:key/test-send`, see
      `apps/mobile/lib/platform-hooks.ts:214-219` and `platform-contracts.ts:409-430`).
    - That is a versioned MARKETING EMAIL registry with a test-send, which is exactly why
      routes.ts:593-595 talks about `mass-send` and "template test-sends", and why `web`
      records `/admin/notifications/lead-templates`.
    - This task builds something else: an operator-authored CRM DM/email snippet, keyed to
      `crm_*` data, with no send path at all.

    Pointing the console at a new `crm_templates` table under that id would give one route
    id two meanings across two renderers — the precise drift `console-core`'s module
    comment says the package exists to prevent.

    A separate id costs nothing and has an exact precedent: `platform.crmSuppressions` and
    `platform.crmImport` are console-native, declare only `mobile` + `capability`, have no
    mobile screen, and rely on `consolePath`'s fallback. No exclusion in
    `routes.console.test.ts` is needed.
  </context>
  <options>
    <option id="new-id">
      <name>Add `platform.crmTemplates` (RECOMMENDED — the rest of this plan assumes it)</name>
      <pros>One id, one meaning. Sits in the CRM cluster with its siblings. `platform.leadTemplates` stays pending and honest about the marketing registry that is still coming. No test exclusion needed.</pros>
      <cons>Two similarly named ids in routes.ts; needs a comment saying which is which (Task 4 writes it).</cons>
    </option>
    <option id="reuse-id">
      <name>Un-pend `platform.leadTemplates` and serve the CRM composer there</name>
      <pros>Matches the brief's wording literally; no new id.</pros>
      <cons>The mobile screen at that id renders a different contract from a different API. The route's own comment about `mass-send` test-sends becomes false. `web` points at a predecessor this surface does not replace.</cons>
    </option>
  </options>
  <action>
    Present the evidence above and take the decision. Do not write any code in this task.
    Record the answer at the top of Task 4's commit message body-free description (single-line
    commit, so record it in the route comment instead). Every later task assumes `new-id`; if
    the answer is `reuse-id`, Task 4's route/nav edits change and nothing else in this plan does.
  </action>
  <files>packages/console-core/src/routes.ts (read only in this task)</files>
  <verify>
    <automated>MISSING — a decision has no automated check; the resume-signal is the gate.</automated>
  </verify>
  <done>The route id this surface ships under is chosen and stated back.</done>
  <resume-signal>Select: new-id or reuse-id. If `reuse-id`, say what happens to the mobile screen and its `/lead-templates` API contract.</resume-signal>
</task>

<task type="auto">
  <name>Task 1: Create the crm_templates table</name>
  <files>
    apps/web/db/migrations/0043_crm_templates.sql
    apps/console/lib/db/crm-templates-schema.integration.test.ts
  </files>
  <depends_on>none</depends_on>
  <action>
    New migration, next number after 0042.

    `CREATE TYPE crm_template_channel AS ENUM ('dm', 'email');`

    `CREATE TABLE crm_templates (id uuid PK DEFAULT gen_random_uuid(), name text NOT NULL,
    channel crm_template_channel NOT NULL, product text, subject text, body text NOT NULL,
    is_archived boolean NOT NULL DEFAULT false, created_by text NOT NULL, created_at
    timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT crm_template_subject_is_email_only CHECK ((channel = 'email') OR subject IS NULL));`

    Index: a partial index on `(channel) WHERE NOT is_archived` — the composer's only read
    is "live templates for this channel", and the archived rows are the majority over time.

    Write the header comment at this repo's register — an essay about the decision, not
    "-- add table". It must say, at minimum:

    (a) WHY A TABLE AND NOT CHECKED-IN CONFIG. Campaign copy changes in response to reply
        rate. A constant in `lib/` means every wording change is a deploy, and the operator
        who reads the replies is not the person who can ship one. The cost of the table is
        a migration; the cost of the constant is that the copy stops being tuned.
    (b) WHY `product` IS NULLABLE AND MEANS "any". Same reasoning `crm_opportunities.product`
        already records: the estate is a TypeScript constant, not a table, so there is no FK
        to hang this on, and a template written before anyone decided which product it sells
        must still be usable. Null is "any product", not "unknown".
    (c) WHY THE SUBJECT CHECK. A DM has no subject line. Without the CHECK, a subject
        authored against a `dm` template is silently dropped at render, and the operator
        never learns their words went nowhere. The database is the only place that can
        hold this, because both the form and the renderer are things a future caller can
        route around.
    (d) NO `body` LENGTH LIMIT AND NO RENDERED-COPY COLUMN. This table holds the UNRENDERED
        source only. Point at 0027's DPDP paragraph and at `crm-erasure.ts`: the rendered
        text embeds `crm_contacts.biography`, `eraseContact` does not reach every table, and
        a rendered copy stored anywhere is the compliance defect 0027 names. Nothing in this
        schema stores one, deliberately.
    (e) NO `updated_at` TRIGGER. There are no triggers on these tables (see `advanceStage`);
        writers set it explicitly.

    Migration only in this commit — no reads, no writes, no repo module.
  </action>
  <verify>
    <automated>cd apps/console &amp;&amp; npx vitest run lib/db/crm-templates-schema.integration.test.ts</automated>
    The test loads 0019 then 0043 into PGlite (harness copied from
    `crm-erasure.integration.test.ts`) and asserts:
    - inserting `channel='dm'` with a non-null `subject` is REJECTED by
      `crm_template_subject_is_email_only`
    - inserting `channel='dm'` with `subject` null succeeds
    - inserting `channel='email'` with a subject succeeds
    - `channel='sms'` is rejected by the enum
    - a fresh row has `is_archived = false`
  </verify>
  <done>Migration file exists, applies cleanly into PGlite, and every CHECK/enum claim above is asserted.</done>
  <commit>feat(crm): add crm_templates for operator-authored outreach copy</commit>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Merge-field rendering that refuses to half-render</name>
  <files>
    apps/console/lib/crm-merge-fields.ts
    apps/console/lib/crm-merge-fields.test.ts
  </files>
  <depends_on>none</depends_on>
  <behavior>
    - `parseMergeFields("Hi {{contact.name}} at {{org.name}}")` → `["contact.name", "org.name"]`, in order, deduped.
    - `parseMergeFields` on an unknown token (`{{contact.followers}}`) → surfaced as unknown, not silently kept.
    - `renderTemplate` with every referenced field present → `{ ok: true, text }` with every placeholder substituted.
    - `renderTemplate` with `contact.biography` null → `{ ok: false, missing: ["contact.biography"] }` and NO `text` property at all.
    - Two missing fields → both named, in template order.
    - An unknown placeholder → `{ ok: false, unknown: ["contact.followers"] }`; never rendered as literal text and never treated as "missing data" (it is an authoring bug, a different message).
    - `org.category` (text[]) joins with ", "; an EMPTY array is MISSING, not an empty string.
    - A whitespace-only value (`biography = "  "`) is MISSING. A scrape yields these routinely and " " substituted reads exactly like the empty case.
    - Substitution is literal: a value containing `{{org.name}}` is not re-scanned.
  </behavior>
  <action>
    Pure module, no imports from `lib/db`, so it stays unit-testable in the node project
    and cannot acquire a database dependency later.

    `MERGE_FIELDS` is a frozen registry mapping token → { label, source }. It contains
    EXACTLY these six and nothing derived:
      `org.name`, `org.location`, `org.category`,
      `contact.name`, `contact.instagram_handle`, `contact.biography`.
    Each entry names the column it reads. A derived or computed field is not addable here
    without a column behind it — write that as a comment, and give the reason: a merge field
    whose value is computed has no null to check, so constraint 1 (below) cannot be enforced
    for it, and the first such field is how "Hi ," gets back in.

    `renderTemplate({ body, subject, values })` returns a discriminated union:
      `{ ok: true; text: string; subject?: string }` | `{ ok: false; missing: string[] } | { ok: false; unknown: string[] }`

    THE RULE, and it goes in the module comment in full: an unresolved placeholder BLOCKS
    the copy. It is never substituted with "", never left as the literal `{{…}}`, and never
    partially rendered. "Hi ," is the tell that makes templated outreach read as spam, and a
    message that does not read as bulk is the entire value of this feature — a renderer that
    degrades gracefully is a renderer that ships the thing we are trying to avoid. The
    function returns NO text in the failure case rather than text plus a warning, because a
    caller can ignore a warning and cannot ignore an absent field.

    Subject is rendered under the same all-or-nothing rule as the body: a missing field
    anywhere in either fails the whole render.
  </action>
  <verify>
    <automated>cd apps/console &amp;&amp; npx vitest run lib/crm-merge-fields.test.ts</automated>
  </verify>
  <done>Every case in `&lt;behavior&gt;` is a named test. The failure shape carries no `text`, provable by `expect("text" in result).toBe(false)`.</done>
  <commit>feat(crm): render lead-template merge fields or refuse outright</commit>
</task>

<task type="auto">
  <name>Task 3: Read and write templates, and read a lead's merge values</name>
  <files>
    apps/console/lib/db/crm-templates.ts
    apps/console/lib/db/crm-templates.integration.test.ts
  </files>
  <depends_on>Task 1, Task 2</depends_on>
  <action>
    Its own module, not `crm-repo.ts` — that file is 2,691 lines and `crm-erasure.ts`
    already set the precedent for "this is neither the read path nor the create path".
    Say so in the module comment.

    Exports:

    `listTemplates(options?: { channel?; includeArchived?: boolean })` → `TemplateRow[]`,
    newest first, archived excluded by default.

    `createTemplate({ name, channel, product, subject, body, actor })` → `TemplateRow`.
    Validate at this boundary before the INSERT: run `parseMergeFields(body)` (and `subject`)
    and REFUSE a template containing an unknown placeholder, throwing
    `UnknownMergeFieldError` (operator-facing, allowlisted by the action in Task 4). The
    reason to check here and not only in the form: a template with a bad token renders
    nothing for every lead forever, and the operator discovers it at the moment they are
    trying to send, on someone else's screen. Reject at authoring time, where the person who
    can fix it is standing.

    `archiveTemplate(id)` → `TemplateRow[]` from `UPDATE … SET is_archived = true, updated_at = now()
    WHERE id = $1 AND NOT is_archived RETURNING …`. Archive, never DELETE: `crm_activities.metadata`
    will carry `template_id` forever, and a deleted template turns every one of those rows into a
    dangling id nobody can resolve. Return the rows the UPDATE actually reported so the caller's
    audit count is the real outcome — the same rule `removeSuppression` already follows.

    `templateContext(organisationId)` → `{ organisation: { name, location, category }, contacts:
    TemplateContactRow[] }` where `TemplateContactRow` is `{ id, name, email, instagramHandle,
    biography }`.

    THREE things this read must do, each with its reason in a comment:
    - EXCLUDE contacts with `erased_at IS NOT NULL`. `eraseContact` writes `'[erased]'` into
      `name`, so an erased contact does not present as missing data — it presents as a name,
      and a template would cheerfully render "Hi [erased]". Filtering here is what makes the
      erasure visible to this feature at all.
    - Return `biography` — the one place in the console that does. It is scrape-derived
      personal data, returned for RENDER ONLY, and Task 7 is where it must be proven never to
      be persisted. Say that here, and point at `crm-outreach.integration.test.ts`.
    - Do NOT reuse `ContactRow`. A separate `TemplateContactRow` keeps `biography` off the
      shape every other CRM surface already renders, so nothing acquires it by accident.
  </action>
  <verify>
    <automated>cd apps/console &amp;&amp; npx vitest run lib/db/crm-templates.integration.test.ts</automated>
    PGlite loading 0019, 0024, 0027, 0043. Asserts: create round-trips; a template with
    `{{contact.followers}}` throws `UnknownMergeFieldError` and inserts NO row; archive flips
    the flag and a second archive returns `[]`; `listTemplates()` hides archived and
    `includeArchived` shows it; `templateContext` omits a contact whose `erased_at` is set,
    and returns `biography` for one that is not.
  </verify>
  <done>All four exports covered; the erased-contact exclusion is a named test.</done>
  <commit>feat(crm): read and write lead templates</commit>
</task>

<task type="auto">
  <name>Task 4: The lead-templates surface</name>
  <files>
    packages/console-core/src/routes.ts
    packages/console-core/src/nav.ts
    packages/console-core/src/nav.test.ts
    apps/console/app/(console)/platform/crm/templates/page.tsx
    apps/console/app/(console)/platform/crm/templates/actions.ts
    apps/console/app/(console)/platform/crm/templates/actions.test.ts
    apps/console/app/(console)/platform/crm/templates/page.test.tsx
    apps/console/app/(console)/platform/crm/templates/templates-view.tsx
  </files>
  <depends_on>Task 0, Task 2, Task 3</depends_on>
  <action>
    ROUTE (assuming Task 0 resolved to `new-id`). Add beside `platform.crmSuppressions`:

      "platform.crmTemplates": { mobile: "/platform/crm/templates", capability: "crm" },

    `mobile`-only + no `web`, exactly like `crmSuppressions`/`crmImport`: console-native, and
    `consolePath` falls back to `mobile`, so `routes.console.test.ts`'s "console path agrees
    with mobile" loop passes with no exclusion. NOT `pending` — this task builds it.

    The comment must distinguish it from `platform.leadTemplates`, which stays pending, in
    these terms: that id is the versioned MARKETING EMAIL registry the platform API already
    serves (`GET /lead-templates`, `htmlBody`/`version`/`status`, and a test-send that is why
    its comment names `mass-send`); `apps/mobile/app/platform/lead-templates.tsx` renders it
    today. This id is CRM outreach copy — operator-authored, `crm_*`-scoped, with NO send path
    of any kind. Two surfaces, two ids, so neither renderer has to guess.

    NAV: add `{ name: "Templates", route: "platform.crmTemplates", icon: "mail" }` to the CRM
    cluster in `platformNav`, directly after "Do-not-contact". Extend `nav.test.ts` with the
    same shape as the existing "links X rather than showing it as pending" cases.

    PAGE: copy the suppressions surface's three-file shape exactly — `page.tsx` (server, reads
    via `listTemplates`, builds a `SurfaceState` through `resolveState`/`dbReadError`, imports
    from `@/components/kit/surface-state` and NOT `states.tsx`), `templates-view.tsx` (client,
    renders `SurfaceStateView` + the list + the create form), `actions.ts` (both writes through
    `withCrmWrite` with `{ capability: "crm" }`).

    Header: title "Lead templates", description naming what it is for — "Reusable outreach
    copy. Rendered per lead; nothing is sent from here." Breadcrumbs `CRM` → `Templates`.

    ACTIONS: `createTemplateAction`, `archiveTemplateAction`. Audit as `crm.template.create`
    (`summary: { created: 1 }`, `target: name`) and `crm.template.archive` (`summary: { archived:
    rows.length }`, `target: rows[0]?.name ?? id` — the readable fact, per Ruling 20). Pass a
    `mapError` that allowlists `UnknownMergeFieldError` ONLY, naming the bad token; everything
    else falls through to the wrapper's generic message.

    The create form must show the six available merge fields inline — the operator cannot
    guess `{{contact.instagram_handle}}`, and an unguessable token is what the
    `UnknownMergeFieldError` path exists to catch after the fact. Subject input is shown only
    when channel is `email`, mirroring the CHECK.

    `mass-send` is NOT asserted anywhere in this task, because nothing here sends. Do not add
    a test-send control.
  </action>
  <verify>
    <automated>cd apps/console &amp;&amp; npx vitest run app/\(console\)/platform/crm/templates &amp;&amp; cd ../../packages/console-core &amp;&amp; npx vitest run</automated>
    `actions.test.ts` mirrors `suppressions/actions.test.ts`: trims server-side, rejects an
    empty name/body without touching the database, surfaces the unknown-token message,
    revalidates `/platform/crm/templates`. `page.test.tsx` covers empty/error/loaded states.
  </verify>
  <done>Route resolves, rail links it, an operator can create and archive a template end to end, and console-core's suite is green.</done>
  <commit>feat(crm): add the lead templates surface</commit>
</task>

<task type="auto">
  <name>Task 5: Make the stage advance callable inside a caller's transaction</name>
  <files>apps/console/lib/db/crm-repo.ts</files>
  <depends_on>none</depends_on>
  <action>
    Pure refactor, no behaviour change. Task 7 needs the stage move, the stage_change
    activity, the suppression check and its own dm_sent insert in ONE transaction, and
    `tesserixTx` does not nest.

    (1) Extract the body of `advanceStage` into `advanceStageOnQuery(query: TxQuery, input:
        AdvanceStageInput): Promise<AdvanceStageResult>` — identical statements, identical
        order, identical `FOR UPDATE`. `advanceStage` becomes `tesserixTx((query) =>
        advanceStageOnQuery(query, input))`.
    (2) Export `assertNoSuppressedContact` (it already takes a `query`).

    Both get a comment saying WHY they are exported: the rule "every stage transition writes
    a `stage_change` activity in the same transaction, without exception" and the rule
    "outbound contact is refused for a suppressed organisation" are guarantees this file
    owns. A second caller that needed them inside its own transaction had exactly two
    options — reimplement them, or be handed them — and a reimplementation is a second copy
    that can stop agreeing in one commit (the `crm-identity.ts` lesson). Handing them out is
    what keeps one rule in one place.

    Do NOT export `advanceStageOnQuery` from any barrel or use it from an action directly;
    it is for callers already holding a transaction.
  </action>
  <verify>
    <automated>cd apps/console &amp;&amp; npx vitest run lib/db/</automated>
    Every existing crm test passes UNCHANGED — no test file may be edited in this commit.
    That is the whole verification: a refactor that needed a test rewritten was not a refactor.
  </verify>
  <done>`advanceStage` delegates; `assertNoSuppressedContact` and `advanceStageOnQuery` are exported; zero test files touched.</done>
  <commit>refactor(crm): let a caller run the stage advance in its own transaction</commit>
</task>

<task type="auto">
  <name>Task 6: Preview a template against one lead</name>
  <files>
    apps/console/app/(console)/platform/crm/[organisation]/actions.ts
    apps/console/app/(console)/platform/crm/[organisation]/actions.templates.test.ts
  </files>
  <depends_on>Task 2, Task 3</depends_on>
  <action>
    Add `previewTemplate({ organisationId, contactId, templateId })` to the existing actions
    file. Returns a discriminated union, NEVER a partial:

      { ok: true; text: string; subject?: string }
    | { ok: false; reason: "suppressed"; message: string }
    | { ok: false; reason: "missing-fields"; missing: string[]; message: string }
    | { ok: false; reason: "unknown-fields"; unknown: string[]; message: string }
    | { ok: false; reason: "not-found" | "erased"; message: string }

    ORDER IS LOAD-BEARING, and the comment must say so:

      1. SUPPRESSION FIRST, BEFORE RENDER. `isSuppressed({ email, instagramHandle })` on the
         chosen contact. A suppressed person's message is not produced at all — not rendered
         and discarded, produced. The CSV import already checks at BOTH preview and commit
         (crm-repo.ts's suppressions section: "a preview is a promise about a state that may
         already be old"), and this surface takes the same shape: refused here, refused again
         inside Task 7's transaction.
      2. Then load `templateContext` — which already excludes erased contacts, so a contact
         id that vanishes between the page render and this call comes back "erased", not
         "[erased]" rendered into a greeting.
      3. Then `renderTemplate`. Its all-or-nothing contract is what makes the missing-field
         branch reachable at all.

    The missing-field message NAMES the fields using `MERGE_FIELDS[token].label`, e.g.
    "Cannot use this template: no bio recorded for this contact." An operator who is told
    only "cannot render" will retype the message by hand, which is the outcome this feature
    exists to remove.

    This is a READ. It does not go through `withCrmWrite` and writes no audit row — but it
    DOES need the session capability check, because it returns `biography`. Call
    `checkOperatorCapabilityLive(session, "crm")` directly and return `not-found` shape on
    refusal. Comment why the wrapper is not reused: `withCrmWrite` wraps `auditedOperation`,
    and a preview is not an operation worth an audit row — auditing every keystroke-adjacent
    read would bury the rows that record what was actually sent.
  </action>
  <verify>
    <automated>cd apps/console &amp;&amp; npx vitest run app/\(console\)/platform/crm/\[organisation\]/actions.templates.test.ts</automated>
    Asserts, with mocked repo reads: a suppressed contact returns `reason: "suppressed"` AND
    `renderTemplate` was never called (`expect(renderSpy).not.toHaveBeenCalled()`) — that
    assertion is constraint 3, and it must be on call ordering, not just the return value;
    a null biography returns `reason: "missing-fields"` with `["contact.biography"]` and no
    `text` key; a fully populated lead returns the substituted text; an operator without
    `crm` gets no `biography` in any branch.
  </verify>
  <done>Preview refuses before rendering for a suppressed lead, and never returns partially substituted text.</done>
  <commit>feat(crm): preview a lead template, refusing before it half-renders</commit>
</task>

<task type="auto">
  <name>Task 7: Copy and log a templated DM in one transaction</name>
  <files>
    apps/console/lib/db/crm-outreach.ts
    apps/console/app/(console)/platform/crm/[organisation]/actions.ts
    apps/console/app/(console)/platform/crm/[organisation]/template-composer.tsx
    apps/console/app/(console)/platform/crm/[organisation]/template-composer.render.test.tsx
    apps/console/app/(console)/platform/crm/[organisation]/organisation-detail-view.tsx
    apps/console/app/(console)/platform/crm/[organisation]/page.tsx
  </files>
  <depends_on>Task 5, Task 6</depends_on>
  <action>
    REPO — `recordTemplatedDm({ organisationId, contactId, templateId, bodyIfEdited, actor })`
    in a new `crm-outreach.ts`. One `tesserixTx`, in this order, on one client:

      1. `assertNoSuppressedContact(organisationId, query)` — the re-check. Preview promised
         something about a state that may already be old.
      2. INSERT `crm_activities`: `kind = 'dm_sent'`, `contact_id`, `actor`,
         `body = bodyIfEdited ?? NULL`,
         `metadata = { template_id, rendered_at, edited: bodyIfEdited !== null }`.
      3. For every OPEN opportunity on the organisation: `next_action_at = now() + interval
         '4 days'`, `next_action_note` naming the template, `last_contacted_at = now()`,
         `updated_at = now()`.
      4. For each of those still at stage `new`: `advanceStageOnQuery(query, { to: 'contacted', … })`,
         which writes its own `stage_change` activity in this same transaction. Do not write
         the stage UPDATE by hand — that rule belongs to `advanceStage` and Task 5 exported it
         so this caller could honour it rather than copy it.

    THE MODULE COMMENT IS THE POINT OF THIS FILE. It must state constraint 2 in full:

      `crm_activities.body` NEVER receives the rendered message. The render embeds
      `crm_contacts.biography` — scraped personal data about someone who never filled in a
      form (0019's own words). `eraseContact` (crm-erasure.ts) nulls the contact's columns
      and empties `metadata`, and does NOT touch `crm_activities`; activities are only
      destroyed by the organisation cascade, which answers a different request. So a
      rendered body written here would survive an erasure request, in a table the erasure
      path does not reach. Migration 0027 names this exact situation "a compliance defect,
      not a feature". What is persisted is the template id and the timestamp — enough to
      reconstruct WHAT WAS SENT from the template plus the contact row, and by construction
      that reconstruction stops working the moment the contact is erased, which is the
      correct behaviour rather than a limitation.

      THE EDITED-TEXT EXCEPTION, and how the two are told apart. The action re-renders the
      template SERVER-SIDE from `templateId` + the live contact row and compares that string
      to what the client submitted. Identical → the operator sent our render → `body` is
      NULL. Different → the operator wrote it → the text is theirs and goes in `body`. The
      comparison is server-side and not a client flag on purpose: a client that claimed
      "edited" while submitting the verbatim render would otherwise smuggle the biography
      into `body` through the one door that accepts text.

      THE RESIDUAL, stated rather than hidden: an operator who edits one character keeps the
      rest of the render, biography included, and that text is then genuinely theirs and is
      stored. That is accepted — a human deciding what to send is the thing this feature
      exists to preserve — but it is why `metadata.edited` is recorded, so an erasure request
      can find the small set of rows a human authored instead of scanning every activity.

    ACTION — `copyAndLogDm({ organisationId, contactId, templateId, submittedText })` via
    `withCrmWrite(contactId, { capability: "crm" }, …)`. It re-runs the render, computes
    `bodyIfEdited`, calls `recordTemplatedDm`, audits as `crm.outreach.dm` with `summary: {
    logged: 1, edited }` and `target` = the contact's handle or email, NEVER the message text.
    Allowlist `SuppressedContactError` through `mapError` (its message is already
    operator-facing). `revalidatePath` the organisation page.

    CLIENT — `template-composer.tsx`, its own file (the detail view is at 771 lines and the
    existing `activity-composer.tsx` set the precedent). Rendered inside `ActivityTab`
    ABOVE `ActivityComposer`: the templated path is the common case for a stage-`new` lead
    and the free-text log is the fallback. `page.tsx` passes `listTemplates({ channel: 'dm' })`
    down; the composer takes `templates` and `contacts` as props.

    Select a template → select a contact → `previewTemplate` → editable `Textarea` seeded
    with the returned text. When preview returns a failure, the textarea stays EMPTY and the
    copy button is `disabled`, with the reason rendered beside it (`aria-live="polite"`, the
    pattern `FollowUpPrompt` already uses). Never seed the textarea with a partial render.

    ONE CONTROL, "Copy & log DM sent". Ordering inside the click handler, with the reason in
    a comment: `navigator.clipboard.writeText(text)` runs FIRST, synchronously in the click
    handler, before any `await`. The Clipboard API requires transient user activation, and
    awaiting a server round-trip first loses it — the write then rejects in Safari and the
    operator has a logged activity and an empty clipboard, which is the worst of the three
    outcomes because the CRM says the DM was sent. Then `startTransition` → `copyAndLogDm`.
    If the action fails, the error must say the message WAS copied and was NOT logged, so the
    operator knows which half to redo.
  </action>
  <verify>
    <automated>cd apps/console &amp;&amp; npx vitest run app/\(console\)/platform/crm/\[organisation\]/</automated>
    `template-composer.render.test.tsx`: with a `missing-fields` preview the copy button is
    `disabled` and the named field appears in the DOM; with a successful preview it is
    enabled and the textarea holds the rendered text; the clipboard write happens before the
    action resolves; a failing action renders the "copied, not logged" message.
  </verify>
  <done>An operator picks a template and a lead, sees the rendered DM, copies it, and the lead moves new → contacted with a next action 4 days out.</done>
  <commit>feat(crm): copy and log a templated DM in one transaction</commit>
</task>

<task type="auto">
  <name>Task 8: Prove no scrape-derived text reaches crm_activities  ← THE CONSTRAINT-2 PROOF</name>
  <files>apps/console/lib/db/crm-outreach.integration.test.ts</files>
  <depends_on>Task 7</depends_on>
  <action>
    ** This is the task a reviewer must be able to check in isolation. It is a SEPARATE
    commit from Task 7 on purpose — the guarantee should be readable as one diff, not
    buried in the feature that needs it. Do not squash it into Task 7. **

    PGlite loading 0019, 0022, 0024, 0027, 0041, 0043, with the harness from
    `crm-erasure.integration.test.ts` (own instance — a `vi.mock` in one file cannot be
    shared with another).

    Fixture: an organisation, one contact whose `biography` is a UNIQUE SENTINEL string
    (e.g. `"SENTINEL-BIO-8f3c artisan sourdough since 2019"`), one stage-`new` opportunity,
    and a `dm` template whose body references `{{contact.biography}}`.

    Assertions:

    (1) THE SENTINEL SCAN, on the unedited path. Run `recordTemplatedDm` with
        `bodyIfEdited: null`. Then
        `SELECT body, metadata::text FROM crm_activities` — for EVERY row (the `dm_sent` one
        and the `stage_change` one), assert neither `body` nor the stringified `metadata`
        contains the sentinel. Scan the WHOLE serialised metadata object, not named keys:
        the erasure test makes exactly this choice and says why — an assertion about named
        keys passes while everything a future writer adds survives.
    (2) THE NEGATIVE CONTROL. Assert the render actually contained the sentinel
        (`expect(rendered).toContain(SENTINEL)`) before asserting it is absent from the
        table. Without this, the test passes trivially the day the fixture stops populating
        `biography`, and a green suite would be evidence of nothing.
    (3) WHAT IS PERSISTED INSTEAD. `metadata->>'template_id'` equals the template id,
        `metadata->>'rendered_at'` parses as a timestamp, `metadata->>'edited'` is `false`,
        and `body IS NULL`.
    (4) THE EDITED PATH IS DISTINGUISHED. Run again with `bodyIfEdited` = operator-authored
        text containing no sentinel. Assert `body` equals that text and `metadata->>'edited'`
        is `true`.
    (5) THE SMUGGLING ATTEMPT. Call the ACTION (not the repo) with `submittedText` equal to
        the verbatim server render. Assert `body IS NULL` and `edited` is `false` — the
        server-side re-render comparison, not a client flag, is what decides.
    (6) SURVIVES ERASURE. Run `eraseContact(contactId)`, then scan `crm_activities` again for
        the sentinel across `body` and `metadata::text` on every row. Zero matches. This is
        the assertion that states the whole point: activities outlive the erasure, so nothing
        derived from the erased columns may ever have been written there.
    (7) SUPPRESSION RE-CHECK. Insert a suppression on the contact's handle AFTER the preview
        would have passed, then call `recordTemplatedDm` — expect `SuppressedContactError`
        and assert NO `crm_activities` row was inserted and the stage did NOT move (the
        transaction rolled back as a unit).
    (8) THE STAGE AND CLOCK. Assert stage moved `new` → `contacted`, a `stage_change` row
        exists, `next_action_at` is ~4 days out, and `last_contacted_at` moved.

    Head the file with a comment naming what it defends and why a reviewer is reading it:
    `crm_activities` is not reachable by `eraseContact`, the rendered DM embeds
    `crm_contacts.biography`, and the only thing standing between those two facts and a
    compliance defect is this file.
  </action>
  <verify>
    <automated>cd apps/console &amp;&amp; npx vitest run lib/db/crm-outreach.integration.test.ts</automated>
    Then, as a mutation check the executor performs and reports (do not commit it): change
    `body = bodyIfEdited ?? NULL` to `body = renderedText` in `crm-outreach.ts` and confirm
    assertions (1) and (6) FAIL. Revert. A guarantee test that cannot be made to fail is not
    a guarantee test.
  </verify>
  <done>Eight assertions green; the deliberate mutation turns the suite red; the mutation is reverted and not committed.</done>
  <commit>test(crm): prove no scraped biography text reaches crm_activities</commit>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser → server action | Operator-supplied `submittedText`, `templateId`, `contactId` cross here untrusted |
| server → crm_activities | The one write that can persist scrape-derived personal data past an erasure |
| crm_templates.body → renderer | Operator-authored text with `{{…}}` tokens, rendered into a message |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-LDQ-01 | Information disclosure | `crm_activities.body` | mitigate | Server-side re-render comparison decides `body`; a client cannot mark verbatim render as "edited" (Task 7). Proven by Task 8 (1)(5)(6). |
| T-LDQ-02 | Information disclosure | `templateContext` returns `biography` | mitigate | Separate `TemplateContactRow`, not `ContactRow`, so no other surface acquires it; `checkOperatorCapabilityLive(session, "crm")` on the preview action (Task 6). |
| T-LDQ-03 | Tampering | `previewTemplate` / `copyAndLogDm` args | mitigate | `organisationId` scopes every read and write; contact is looked up through `templateContext(organisationId)`, so a contact id from another organisation resolves to nothing. |
| T-LDQ-04 | Repudiation | Outreach with no record | mitigate | `crm.outreach.dm` audit row via `withCrmWrite`; the `dm_sent` activity and the stage move are in one transaction with it (Task 7). |
| T-LDQ-05 | Elevation of privilege | Sending on behalf of the estate | accept-by-exclusion | No send path exists in any task. `mass-send` is never asserted because nothing here sends. A future send action must assert it itself, as routes.ts already records. |
| T-LDQ-06 | Information disclosure | Contacting a suppressed person | mitigate | Checked at preview before render (Task 6) and re-checked inside the write transaction (Task 7), the same both-ends rule `previewImport`/`commitImport` already hold. |
| T-LDQ-07 | Denial of service | Instagram account restriction from volume | accept | Per-lead composer only; no bulk mode, no queue, no send. Manual pace is the control, and it is the reason bulk is out of scope rather than deferred. |
| T-LDQ-SC | Tampering | npm/pip/cargo installs | n/a | No new dependencies. PGlite, Vitest and `@tesserix/web` are all already in `apps/console`. Any task that finds it needs a new package must stop and escalate. |
</threat_model>

<verification>
Run from the repo root before the final commit:

```
pnpm -r --filter "./packages/**" build     # console-core dist must be current or the alias story bites
cd apps/console && npx vitest run
cd ../../packages/console-core && npx vitest run
cd ../.. && npx tsc --noEmit -p apps/console
```

Manual, once: `/platform/crm/templates` renders and accepts a template; open a stage-`new`
Mark8ly organisation, pick that template, confirm a lead with no `biography` disables the
copy control and names the field, and a complete lead copies and advances to `contacted`.
</verification>

<success_criteria>
- Migration 0043 applies; the subject CHECK and the channel enum are enforced.
- `renderTemplate` returns no `text` whenever any referenced field is missing — asserted.
- A suppressed lead is refused BEFORE `renderTemplate` is called — asserted on call order.
- `crm_activities` never contains the biography sentinel, including after `eraseContact`, and
  the deliberate mutation in Task 8's verify makes that assertion fail.
- One click copies and logs: `dm_sent` + `next_action_at` +4d + `last_contacted_at` +
  `new` → `contacted` + its `stage_change` row, all in one transaction.
- No send path, no test-send, no bulk mode anywhere in the diff.
- Eight commits, one per task, single-line conventional messages, no signatures.
</success_criteria>

<output>
No SUMMARY file — quick mode. Report back: commits made, the Task 8 mutation result, and
the Task 0 decision as taken.
</output>
