-- The internal tools directory, moved out of packages/console-core/src/tools.ts.
--
-- Two tables rather than one because #318 moves the group vocabulary too. The
-- foreign key below is what replaces the `ToolGroup` union type: a tool in an
-- undeclared group cannot exist, and a group with tools cannot be deleted.
--
-- What the code KEEPS is host derivation. `subdomain` is a single DNS label,
-- never a URL, so `toolUrl(tool, baseDomain)` still decides which environment
-- a link points at — a row carrying https://grafana.tesserix.app would send a
-- dev console's operators to production, permanently and invisibly. The CHECK
-- is what makes that unstorable rather than merely discouraged.

CREATE TABLE IF NOT EXISTS platform_tool_groups (
    key        text PRIMARY KEY,
    label      text NOT NULL,
    sort_order integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_tools (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    subdomain  text NOT NULL UNIQUE
               CONSTRAINT platform_tools_subdomain_is_a_dns_label
               CHECK (subdomain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND length(subdomain) <= 63),
    purpose    text NOT NULL,
    note       text,
    group_key  text NOT NULL REFERENCES platform_tool_groups (key) ON DELETE RESTRICT,
    sort_order integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_tools_group_order
    ON platform_tools (group_key, sort_order);

-- The seed is today's directory, in today's order, so the rendered page is
-- unchanged on the day of cutover.

INSERT INTO platform_tool_groups (key, label, sort_order) VALUES
    ('identity',      'Identity and secrets', 1),
    ('observability', 'Observability',        2),
    ('delivery',      'Delivery',             3),
    ('cost',          'Cost',                 4),
    ('reference',     'Reference',            5)
ON CONFLICT (key) DO NOTHING;

INSERT INTO platform_tools (name, subdomain, purpose, note, group_key, sort_order) VALUES
    ('Zitadel', 'auth',
     'Identity platform. Operators, organisations, projects and roles.',
     NULL, 'identity', 1),
    ('Secret service', 'secret-service',
     'Admin console for OpenBao and GCP Secret Manager, and which namespaces may read each secret.',
     'Separate login — independent of the platform''s identity on purpose.', 'identity', 2),
    ('Grafana', 'grafana',
     'Dashboards and charts over the metrics pipeline.',
     NULL, 'observability', 1),
    ('Observability', 'observability',
     'Tesserix''s own OTel trace and log explorer.',
     NULL, 'observability', 2),
    ('Prometheus', 'prometheus',
     'Raw metric queries, when a Grafana panel is not enough.',
     NULL, 'observability', 3),
    ('Alertmanager', 'alertmanager',
     'Firing alerts, silences and routing.',
     NULL, 'observability', 4),
    ('Kibana', 'kibana',
     'Full-text log search across workloads, when you have a message but no trace.',
     NULL, 'observability', 5),
    ('OpenPanel', 'analytics',
     'Self-hosted product analytics — page views and events.',
     NULL, 'observability', 6),
    ('ArgoCD', 'argocd',
     'What is deployed, and whether it matches git.',
     'Reached outside the Istio gateway; its own login.', 'delivery', 1),
    ('Kargo', 'kargo',
     'Promotes images between stages. Where a stuck rollout shows up.',
     NULL, 'delivery', 2),
    ('Kubecost', 'kubecost',
     'Cluster spend by namespace and workload.',
     NULL, 'cost', 1),
    ('Cost estimator', 'costestimator',
     'Models the cost of a change before making it.',
     NULL, 'cost', 2),
    ('Agentic registry', 'aregistry',
     'Registry for agentic artifacts — skills, tools, MCPs, prompts.',
     NULL, 'reference', 1),
    ('Design system', 'ui',
     'Storybook for @tesserix/web — the components every app is built from.',
     NULL, 'reference', 2),
    ('Docs', 'docs',
     'Engineering documentation.',
     NULL, 'reference', 3)
ON CONFLICT (subdomain) DO NOTHING;
