# Audit Refused Mutations Implementation Plan (#409)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a deliberately refused mutation leave an audit row, so "who tried to change what we charge, and was stopped" is answerable — especially for a refused **live** publish, which today writes nothing at all.

**Architecture:** `auditedOperation` currently writes only on success, because `describe` takes the operation's *result* and a refusal has none. It gains a second, narrow path: when the operation throws something that is a **deliberate refusal**, write a row describing the refusal and then rethrow. Failures — a database outage, a network error — are untouched and still write nothing.

**Tech Stack:** TypeScript, Next.js server actions, PostgreSQL via `audit-repo`, vitest, pnpm.

**Spec:** [tesserix-home#409](https://github.com/tesserix/tesserix-home/issues/409). Decision taken 2026-08-30: **audit deliberate refusals only, estate-wide.**

## Global Constraints

- **A refusal is a decision; a failure is not.** Only errors that represent policy saying *no* are audited. A `AuditWriteError`, a dropped connection, a bug — these write nothing. Putting an audit write on the failure path would place a database write exactly when the database may be what broke, and would bury the deliberate refusals in operational noise.
- **The original error must still reach the caller.** Auditing a refusal changes what is recorded, never what the user or the calling code sees. `auditedOperation` rethrows.
- **A refusal row must be impossible to misread as a success.** Different action name, and a summary that says what was refused and why.
- **Action names are validated by pattern, not by allowlist** — `ACTION_NAME` requires a stable dotted identifier (`audit-repo.ts`'s `validateActionName`). `catalog.publish.refused` is valid; no vocabulary or schema change is needed. Do not invent an `outcome` column.
- **`auditedOperation` has 8 call sites** — CRM suppressions, CRM organisation, CRM import, catalog actions, `crm-write.ts`, `tools-write.ts`, `crm-repo.ts`. This is a shared primitive: every existing caller must keep working unchanged, and none should need editing unless it has a refusal to describe.
- `pnpm --filter console exec vitest run`, `lint`, `tsc --noEmit`, and `build` are all required. Note the `exec`.

---

### Task 1: Teach `auditedOperation` to record a refusal

**Files:**
- Modify: `apps/console/lib/db/audit-repo.ts`
- Test: `apps/console/lib/db/audit-repo.test.ts`

**Interfaces:**
- Produces: an exported `AuditableRefusal` interface and its type guard, plus the new behaviour in `auditedOperation`. Task 2 implements the interface on `PublishRefused`; Task 3 tests the capability path.

**Read `auditedOperation` and the errors around it first.** The function is deliberately shaped so that a caller cannot forget to audit — its doc comment argues that a bare `writeAuditEntry()` puts the guarantee in the caller's discipline. Your change must not weaken that: a refusal that *should* be audited and is not is the same class of bug.

- [ ] **Step 1: Write the failing tests**

```
- a deliberate refusal writes a row AND the original error still propagates
- the refusal row's action differs from the success action for the same operation
- a plain Error (a failure) writes NOTHING and propagates unchanged
- an AuditWriteError from the operation writes nothing and propagates
- a successful operation still writes exactly one row, unchanged from today
- if the refusal's own audit write fails, the ORIGINAL refusal still reaches the
  caller — a caller must not be told "audit failed" when what happened is "you
  were refused"
```

That last case is the subtle one. Decide deliberately and document it in the code: the refusal is what the user needs to know, but an unrecorded refusal is exactly the gap this issue exists to close. Consider logging the audit failure server-side while rethrowing the refusal, and say why in a comment.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
pnpm --filter console exec vitest run lib/db/audit-repo.test.ts
```

- [ ] **Step 3: Implement**

Add the opt-in shape — an error declares its own audit description, so the decision lives with the error rather than being duplicated across call sites:

```ts
export interface AuditableRefusal {
  /** What the audit row should say about this refusal. */
  readonly auditRefusal: () => AuditDescription;
}

export function isAuditableRefusal(value: unknown): value is Error & AuditableRefusal
```

Then wrap the operation. Keep the existing success path byte-identical in behaviour:

```ts
let result: T;
try {
  result = await spec.operation();
} catch (cause) {
  // A DELIBERATE refusal is a decision and belongs in the log. A failure is
  // not a decision: writing a row for one would put a database write on the
  // path where the database is the likely cause, and would bury the refusals
  // worth reading. See #409.
  const refusal = refusalDescription(cause);
  if (refusal) { /* write, then rethrow `cause` */ }
  throw cause;
}
```

`CapabilityError` lives in `@tesserix/platform-auth` and cannot implement a console-local interface — the dependency runs the wrong way. Recognise it in one adapter inside `audit-repo`, importing the class rather than duck-typing on `name`:

```ts
function refusalDescription(cause: unknown): AuditDescription | null {
  if (isAuditableRefusal(cause)) return cause.auditRefusal();
  if (cause instanceof CapabilityError) return { /* action, summary naming the required capability */ };
  return null;
}
```

Two places, both explicit, neither guessing from a string.

- [ ] **Step 4: All four gates**

```bash
pnpm --filter console exec vitest run
pnpm --filter console lint
pnpm --filter console exec tsc --noEmit
pnpm --filter console build
```

Paste real output for each. The full suite matters: this is a shared primitive with 8 call sites.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/db/audit-repo.ts apps/console/lib/db/audit-repo.test.ts
git commit -m "feat(audit): record a deliberately refused mutation, and rethrow it"
```

---

### Task 2: Make a refused publish describe itself

**Files:**
- Modify: `apps/console/app/(console)/platform/billing/catalog/actions.ts`
- Test: `apps/console/app/(console)/platform/billing/catalog/actions.test.ts`

**Interfaces:**
- Consumes: Task 1's `AuditableRefusal`.

`PublishRefused` is raised from three places (`actions.ts:579`, `:602`, `:625`), including the mode guard that refuses live publishing. Today all three write nothing.

- [ ] **Step 1: Write the failing tests**

```
- a publish refused by the MODE guard writes a row naming the attempted mode
- a publish refused by each of the other two guards writes a row naming which rule refused
- every refusal row's action is distinct from a successful publish's action
- the caller still receives the refusal unchanged — the action's return shape
  and message are exactly what they are today
```

The mode case is the one that matters most: a refused **live** attempt is the single most interesting row this change adds.

- [ ] **Step 2: Run and confirm they fail**

- [ ] **Step 3: Implement**

Give `PublishRefused` an `auditRefusal()` and carry enough context at each throw site for it to be useful — the attempted mode and which rule refused. A row saying only "refused" answers none of the questions the log is for.

Record the operator and the plan's shape. **Do not put catalog rows or amounts in the summary** — `AuditSummary` has nowhere for rows to go, which `AuditedOperation.describe`'s doc comment already states, and a refusal is not the place to start.

- [ ] **Step 4: All four gates, then commit**

```bash
git commit -m "feat(catalog): record refused publish attempts, including refused live attempts"
```

---

### Task 3: Confirm the capability path, and leave the other callers alone

**Files:**
- Test: `apps/console/lib/crm-write.test.ts` or wherever a capability refusal is exercised — find it rather than assuming

**Interfaces:** none. This task proves Task 1 generalised without touching the callers.

The issue asks whether capability failures deserve the same treatment. They do — they are the same shape, and Task 1's adapter already covers them. This task proves it and pins it.

- [ ] **Step 1: Write the test**

```
- an operation refused by CapabilityError writes an audit row naming the required capability
- the CapabilityError still propagates to the caller unchanged
- an existing successful CRM/tools write is unaffected — same single row as today
```

- [ ] **Step 2: Verify no other call site changed behaviour**

Run the full suite and confirm nothing else moved. If a test elsewhere now sees an extra audit row, that is a real finding: it means that call site was throwing something classed as a refusal, and it deserves a look rather than an updated expectation.

- [ ] **Step 3: Commit**

```bash
git commit -m "test(audit): pin that a capability refusal is recorded and still propagates"
```

---

### Task 4: Verify against the database

**Files:** none. Evidence.

- [ ] **Step 1: Exercise a real refusal**

Against the deployed console, attempt a publish to `live` — which `checkMode` refuses by construction — and confirm a row appears in `console_audit_log` naming the operator, the attempted mode, and the refusing rule, with an action distinguishable from a successful publish.

- [ ] **Step 2: Record it on #409**

Paste the row. This issue exists because a refused live attempt left no trace; the evidence that closes it is a refused live attempt that did.

---

## Why this matters now, in one line

The next thing to happen in this arc is provisioning `STRIPE_WRITE_KEY_LIVE` and lifting the live-publish refusal (tesserix-home#327). Until #409 lands, **the first live publish attempt is the one with no audit trail** — and a refused first attempt is precisely the event worth having a record of.
