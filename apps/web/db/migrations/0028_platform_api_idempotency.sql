-- 0028_platform_api_idempotency.sql
--
-- Replay protection for the platform API's write verbs, decided in #269 as
-- one of the conventions the tickets module fixes for every module after it.
--
-- Why it is needed at all: the console's two ticket writes are a reply and a
-- status change, and neither has a natural uniqueness constraint. A reply is
-- append-only free text — the same operator legitimately sends "any update?"
-- twice — so the database cannot tell a retry from a repeat. A network timeout
-- on a request that actually succeeded, a double-submitted form, or Knative
-- retrying at the ingress all produce the same thing today: two identical
-- messages on a merchant's ticket, and no way to tell which was intended.
--
-- Why this table and not a natural key: making (ticket_id, content) unique
-- would forbid a merchant being asked the same question twice, which is a real
-- thing support does. The uniqueness that matters is of the REQUEST, not of
-- its content, and only the caller can assert that — which is what an
-- Idempotency-Key is.
--
-- Why a table rather than Redis: this service has no Redis and ADR-003 D2a is
-- explicit about not adding infrastructure the estate cannot afford. The write
-- rate is bounded by operators typing. More importantly, the guarantee wanted
-- here is that the record and the write land together or not at all, and that
-- is a transaction — which a second datastore cannot join.

BEGIN;

-- =======================================================================
-- platform_api_idempotency
--
-- One row per (principal, key). Written in the SAME transaction as the
-- operation it protects, so a recorded key always corresponds to a completed
-- write and a rolled-back write leaves no key behind. That ordering is the
-- entire guarantee: recording first and writing after would refuse the retry
-- of a request that never landed.
-- =======================================================================
CREATE TABLE platform_api_idempotency (
  -- The caller's Idempotency-Key, verbatim. Bounded by the API, which refuses
  -- anything longer before it reaches here.
  idempotency_key text NOT NULL,

  -- The principal that presented the key — a Zitadel `sub`, operator or
  -- machine user. Part of the primary key so one caller's key cannot collide
  -- with, or be replayed by, another's. Without it a key is a guessable
  -- cross-principal handle onto somebody else's stored response.
  --
  -- text, not uuid, for the reason migrations 0003, 0017 and 0018 all record:
  -- a foreign-issued identifier stored as uuid fails the implicit cast and
  -- lies about its shape.
  principal text NOT NULL,

  -- What the key was used for, as the same dotted identifier the audit trail
  -- uses (`tickets.reply`). Recorded so a key reused across two different
  -- operations is a conflict rather than a wrong stored response being
  -- replayed at the wrong endpoint.
  operation text NOT NULL,

  -- A digest of the request body. NOT the body: a reply's text is the
  -- merchant's conversation, and copying it here would put a second, longer
  -- retained copy beside the one that already exists — the same line
  -- migration 0018 drew for console_audit_log.metadata.
  --
  -- Its purpose is to catch the dangerous case: the same key presented with a
  -- DIFFERENT body. That is not a retry, it is a client bug or a replay, and
  -- returning the first response to it would silently discard the second
  -- request. The API answers 409 instead.
  request_digest text NOT NULL,

  -- The response the first attempt produced, replayed verbatim to a retry.
  -- Stored so a retry is indistinguishable from the original — a retry that
  -- got 200 with a different body would defeat the point.
  response_status int  NOT NULL,
  response_body   text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (principal, idempotency_key)
);

-- Retention: these are worth keeping only as long as a client might retry.
--
-- Not implemented, for the reason 0018 gives about its own retention: it is
-- one scheduled statement against the index below and needs no schema change,
-- so guessing the interval now buys nothing. The working assumption is 24
-- hours, which is well beyond any HTTP client's retry window and short enough
-- that the table stays small on a db-f1-micro.
--
--   DELETE FROM platform_api_idempotency WHERE created_at < now() - interval '24 hours'
--
-- Unlike console_audit_log, this table SHOULD be swept: it holds stored
-- response bodies, it is written by machines rather than by humans typing, and
-- nothing reads a row older than a retry window.
CREATE INDEX platform_api_idempotency_created_idx
  ON platform_api_idempotency (created_at);

COMMIT;
