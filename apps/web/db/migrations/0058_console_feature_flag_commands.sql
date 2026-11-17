CREATE TABLE console_feature_flag_commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product text NOT NULL CHECK (product = 'helivanta'),
    actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
    request_key uuid NOT NULL,
    request_hash text NOT NULL CHECK (length(request_hash) = 64),
    flag_key text NOT NULL CHECK (flag_key ~ '^[a-z][a-z_]{0,63}$'),
    desired boolean NOT NULL,
    expected_revision text NOT NULL CHECK (length(expected_revision) = 64),
    base_version integer NOT NULL CHECK (base_version >= 0),
    reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
    state text NOT NULL CHECK (state IN ('queued', 'dispatching', 'succeeded', 'failed', 'in_doubt')),
    outcome_code text NOT NULL DEFAULT '',
    provider_version integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (product, actor, request_key)
);
CREATE UNIQUE INDEX console_feature_flag_commands_unresolved
    ON console_feature_flag_commands (product)
    WHERE state IN ('queued', 'dispatching', 'in_doubt');
CREATE INDEX console_feature_flag_commands_recent
    ON console_feature_flag_commands (product, created_at DESC, id DESC);
