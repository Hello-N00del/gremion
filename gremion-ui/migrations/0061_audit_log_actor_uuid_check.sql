-- gremion:phase expand
-- 0061_audit_log_actor_uuid_check.sql
-- TASK-033-a (lane note 1.9, TRD-147): an audit actor is an identifier, never a
-- name. audit_log.user_id is TEXT (0009) and the hash canonical form is built
-- from user_id::text, so ALTER ... TYPE uuid would risk the chain and fails on
-- any legacy row. A CHECK ... NOT VALID refuses every NEW free-text actor (a
-- name or an e-mail address would defeat the actor scan) and leaves existing
-- rows, their hashes and the chain untouched; the column becomes uuid at the
-- re-initialisation (TASK-038). Two forms are accepted: the lowercase
-- 8-4-4-4-12 uuid writeAuditEntry stores for a person, and a service principal
-- `<token>-service` (the audit consumers write 'calendar-service',
-- 'content-service' and 'newsletter-service' as the actor of an event they
-- record: a fixed identifier of a component, never a person).
--
-- A session without a `sub` claim therefore has no audit actor: gremion-ui
-- refuses such a session at the door (hooks.server.ts) instead of inventing an
-- actor from preferred_username or jti, which this CHECK would reject (23514)
-- and roll the audited act back.
--
-- The append-only REVOKE on audit_log (no DELETE, UPDATE or TRUNCATE for the
-- app, the owner or PUBLIC) is NOT in this file: a REVOKE is not an expand
-- statement, and it must be re-asserted after every migration anyway.
-- @gremion/tenant-store ensureKernelAuditAppendOnly does it, as the kernel-server
-- admin through the pinned-search_path admin path, at provisioning and on
-- reconcile (idempotent), and states its limit honestly (the app role is a
-- member of the owner role until TASK-192). audit_log is a governance record
-- (RC-GOV-CHAIN): no timer purges it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_id_uuid_chk
  CHECK (
    user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR user_id ~ '^[a-z][a-z0-9]{1,30}-service$'
  ) NOT VALID;
