# Agent execution attribution in AI usage

Extend the existing asynchronous gateway ledger with nullable agent_id,
agent_version and agent_run_id. Kora's reviewed agent definition supplies the
stable ID and version; the runtime generates the run UUID before execution and
passes that same UUID to ADK. Context variables isolate simultaneous runs and
reset even on failure. Direct API model calls have no agent identity.

Authenticated workload headers carry those fields to gateway metadata before
provider header removal. ExtProc carries them to JEV's private decision route,
so decision and model spend group under the initiating agent. They are telemetry,
never authorization inputs. Prompt contents and credentials are excluded.
Platform access remains capability-protected. Historical events stay unattributed.

Reuse the current ledger rather than a synchronous agent lookup or second store.
Three strings add at most a few hundred bytes per attributed event; no new pods,
network calls or LLM tokens. Traffic volume and p99 are not measured; this retains
existing request deadlines and asynchronous accounting availability. Agent reads
use the existing product/time index and at most the 30-day raw retention window.
When the new breakdown fails, other Console sections remain available.

Apply additive migration 0056 before API/ingest rollout, then gateway, agent and
processor changes, and Console. Rollback images while retaining nullable columns
and collected evidence. No historical backfill. Show agent totals on Overview
and Users and services; show version/run on Events next to user/service/model.
