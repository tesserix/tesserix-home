-- Public list-price estimates, verified 2026-10-11, not invoice amounts.
-- Vertex global: https://cloud.google.com/vertex-ai/generative-ai/pricing
-- Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
-- TypeSafe: https://typesafe.ai/ ($42 / billion INPUT tokens).
-- No verified TypeSafe output rate is available. Its output row is deliberately
-- absent: the writer reports the known input cost with cost_source='partial'.
INSERT INTO ai_model_prices(provider, model, token_kind, usd_per_million, effective_from)
VALUES
 ('gcp.vertex_ai','gemini-3.5-flash','input',1.50,'2026-10-11T00:00:00Z'),
 ('gcp.vertex_ai','gemini-3.5-flash','output',9.00,'2026-10-11T00:00:00Z'),
 ('gcp.vertex_ai','gemini-3.5-flash','cached_input',0.15,'2026-10-11T00:00:00Z'),
 ('gcp.vertex_ai','gemini-3.5-flash-lite','input',0.30,'2026-10-11T00:00:00Z'),
 ('gcp.vertex_ai','gemini-3.5-flash-lite','output',2.50,'2026-10-11T00:00:00Z'),
 ('gcp.vertex_ai','gemini-3.5-flash-lite','cached_input',0.03,'2026-10-11T00:00:00Z'),
 ('gcp.vertex_ai','gemini-embedding-001','input',0.15,'2026-10-11T00:00:00Z'),
 ('gcp.vertex_ai','gemini-embedding-001','output',0,'2026-10-11T00:00:00Z'),
 ('anthropic','claude-sonnet-5-5','input',2.00,'2026-10-11T00:00:00Z'),
 ('anthropic','claude-sonnet-5-5','output',10.00,'2026-10-11T00:00:00Z'),
 ('anthropic','claude-sonnet-5-5','cached_input',0.10,'2026-10-11T00:00:00Z'),
 ('typesafe','jev-1.13.0','input',0.042,'2026-10-11T00:00:00Z')
ON CONFLICT DO NOTHING;
