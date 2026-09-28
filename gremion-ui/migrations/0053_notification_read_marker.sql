-- 053_notification_read_marker.sql
-- Design v11 D11 — the notification bell's EXPLICIT read model. Tenant-local
-- (db-per-tenant), additive expand-only, all DDL IF NOT EXISTS. No file-level
-- BEGIN/COMMIT — the runner wraps each file + its schema_migrations insert in one
-- tx (see the 048/049/050 headers). Never edit after ship; append a new migration.
--
-- ONE row per user (keycloak_id TEXT pattern — identities live in Keycloak): the
-- instant the user last pressed "Alle gelesen" in the bell popover. An aggregated
-- notification row (Freigaben / Wahlen / Protokolle) counts as unread while its
-- event timestamp is NEWER than this marker; opening the popover NEVER writes it
-- (read happens only via POST /api/notifications/read-all). Chat rows are
-- deliberately outside this marker — Matrix keeps its own per-room read model,
-- and "Alle gelesen" does not advance Matrix read markers.
--
-- KERNEL-owned (unattributed, like 003/004): the bell aggregates ACROSS modules
-- (finance, elections, protocols, messages), so its read marker is shell chrome —
-- it belongs to no module manifest and is applied on every init. This file
-- references no module-owned schema at all, so the finance migration-ownership
-- guard does not claim it.

CREATE TABLE IF NOT EXISTS notification_read_marker (
  user_keycloak_id TEXT PRIMARY KEY,
  read_at          TIMESTAMPTZ NOT NULL
);
