-- Apply once using a migration role, NOT the model-facing runtime role.
-- Use a dedicated database/schema owned by the operator. This migration is additive.
BEGIN;
CREATE TABLE IF NOT EXISTS pi861_memory_items (
  tenant_id text NOT NULL,
  scope_key text NOT NULL,
  memory_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  body jsonb NOT NULL,
  fingerprint text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, scope_key, memory_id)
);
CREATE TABLE IF NOT EXISTS pi861_memory_receipts (
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  request_id text NOT NULL,
  scope_key text NOT NULL,
  intent_hash text NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, request_id)
);
CREATE TABLE IF NOT EXISTS pi861_memory_tombstones (
  tenant_id text NOT NULL,
  scope_key text NOT NULL,
  fingerprint text NOT NULL,
  PRIMARY KEY (tenant_id, scope_key, fingerprint)
);
CREATE TABLE IF NOT EXISTS pi861_memory_versions (
  tenant_id text NOT NULL,
  scope_key text NOT NULL,
  memory_id text NOT NULL,
  revision bigint NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (tenant_id, scope_key, memory_id, revision)
);
CREATE TABLE IF NOT EXISTS pi861_memory_outbox (
  tenant_id text NOT NULL,
  scope_key text NOT NULL,
  memory_id text NOT NULL,
  revision bigint NOT NULL,
  action text NOT NULL CHECK (action IN ('index', 'withdraw')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, scope_key, memory_id, revision)
);
CREATE INDEX IF NOT EXISTS pi861_memory_items_text
  ON pi861_memory_items USING gin (to_tsvector('simple', coalesce(body->>'full', '')));
-- All query paths also pass explicit scopes. These policies are a second boundary.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pi861_memory_items', 'pi861_memory_tombstones', 'pi861_memory_versions', 'pi861_memory_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t AND policyname = 'pi861_scope') THEN
      EXECUTE format(
        'CREATE POLICY pi861_scope ON %I USING
         (tenant_id = current_setting(''pi861.tenant_id'', true)
          AND scope_key IN (SELECT jsonb_array_elements_text(coalesce(nullif(current_setting(''pi861.read_scopes'', true), ''''), ''[]'')::jsonb)))
         WITH CHECK
         (tenant_id = current_setting(''pi861.tenant_id'', true)
          AND scope_key IN (SELECT jsonb_array_elements_text(coalesce(nullif(current_setting(''pi861.write_scopes'', true), ''''), ''[]'')::jsonb)))', t);
    END IF;
  END LOOP;
END $$;
ALTER TABLE pi861_memory_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi861_memory_receipts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'pi861_memory_receipts' AND policyname = 'pi861_receipt_owner') THEN
    CREATE POLICY pi861_receipt_owner ON pi861_memory_receipts
      USING (tenant_id = current_setting('pi861.tenant_id', true)
             AND principal_id = current_setting('pi861.principal_id', true)
             AND scope_key IN (SELECT jsonb_array_elements_text(coalesce(nullif(current_setting('pi861.read_scopes', true), ''), '[]')::jsonb)))
      WITH CHECK (tenant_id = current_setting('pi861.tenant_id', true)
             AND principal_id = current_setting('pi861.principal_id', true)
             AND scope_key IN (SELECT jsonb_array_elements_text(coalesce(nullif(current_setting('pi861.write_scopes', true), ''), '[]')::jsonb)));
  END IF;
END $$;
COMMIT;
-- Grant only SELECT/INSERT/UPDATE on required tables to a non-superuser, non-BYPASSRLS role.
-- Additionally grant DELETE on pi861_memory_outbox to the trusted consumer role that drains
-- it with SELECT ... FOR UPDATE SKIP LOCKED (OutboxConsumer); index handlers must be idempotent.
-- No default '*', no memory-supplied SQL, and no automatic database creation.
