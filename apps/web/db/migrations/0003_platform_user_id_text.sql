-- 0003_platform_user_id_text.sql
--
-- Relax submitter/author user-id columns from uuid to text. The mark8ly
-- merchant admin (and future product admins) authenticate via Google
-- Identity Platform; user IDs are Firebase UIDs (28-char base62 like
-- "XGHvxPEjOyTKbzNAQzd2NZbQzFu1"), not RFC-4122 UUIDs. Trying to store
-- those in a uuid column fails the implicit cast and Zod's .uuid()
-- pre-validation, so the merchant gets "invalid_payload" on every
-- submission. Storing the foreign identifier as TEXT preserves
-- attribution without lying about its shape.
--
-- Internal references (created_by on announcements, audit-style fields
-- whose author is a tesserix super-admin) keep their uuid type because
-- those rows DO carry a real tesserix-issued UUID.

ALTER TABLE platform_tickets
  ALTER COLUMN submitted_by_user_id TYPE text USING submitted_by_user_id::text;

ALTER TABLE platform_ticket_replies
  ALTER COLUMN author_user_id TYPE text USING author_user_id::text;
