-- Why each public GitHub repository is public: for a window, or permanently.
--
-- Written by platform-api's repos module on the transaction that writes the
-- change's audit row. A row exists only for a repository the console made or
-- marked public; a public repository with no row is one nobody has decided
-- about, and the console flags it as such.
--
-- `temporary` rows are reverted to private by the module's sweeper once
-- `revert_at` passes, and deleted. Making a repository private deletes its row
-- whatever its policy, so a row never describes a private repository for long:
-- the sweeper also deletes a temporary row whose repository someone made
-- private by hand.
--
-- No OWNER TO: see 0039 — the runner connects as the console's role, which is
-- what makes it the owner.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE repo_visibility_policies (
  org       text        NOT NULL,
  repo      text        NOT NULL,
  policy    text        NOT NULL CHECK (policy IN ('permanent', 'temporary')),
  -- When a temporary window closes. Present exactly when the policy is
  -- temporary: a permanent row with a deadline, or a window without one, is a
  -- state the sweeper could only guess about.
  revert_at timestamptz CHECK ((policy = 'temporary') = (revert_at IS NOT NULL)),
  -- The operator's Zitadel subject, as console_audit_log.actor records it.
  set_by    text        NOT NULL,
  set_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org, repo)
);

-- The sweeper's only query: due temporary windows, oldest first.
CREATE INDEX repo_visibility_policies_due
  ON repo_visibility_policies (revert_at)
  WHERE policy = 'temporary';

RESET lock_timeout;
RESET statement_timeout;
