-- Dev seed data — safe to apply on any environment (all inserts are idempotent).
-- Test users. The Keycloak subject ids below are SYNTHETIC placeholders, not the
-- ids of any real account: a Keycloak subject id is assigned by the realm, so on
-- your deployment these rows must be re-pointed at the ids your own realm issued.
-- Passwords are never recorded here — seeded users get SEED_USER_PASSWORD, which
-- scripts/setup.sh generates into .env.
--   test.member  — Keycloak ID: 55555555-0000-0000-0000-000000000010  (role: member)
--   test.admin   — Keycloak ID: 55555555-0000-0000-0000-000000000009  (role: member, council-admin)

-- ── Committees ────────────────────────────────────────────────────────────────

INSERT INTO committees (id, name, description, parent_id, keycloak_group_id)
VALUES
  ('11111111-0000-0000-0000-000000000001', 'Vorstand',          'Geschäftsführender Vorstand des Studierendenrats', NULL, NULL),
  ('11111111-0000-0000-0000-000000000002', 'Ref. Finanzen',     'Finanzreferat', NULL, NULL),
  ('11111111-0000-0000-0000-000000000003', 'Ref. IT',           'IT-Referat', NULL, NULL),
  ('11111111-0000-0000-0000-000000000004', 'AG Öffentlichkeit', 'Öffentlichkeitsarbeitsgruppe', '11111111-0000-0000-0000-000000000001', NULL)
ON CONFLICT (id) DO NOTHING;

-- ── Committee roles ───────────────────────────────────────────────────────────

INSERT INTO committee_roles (id, committee_id, name, election_method)
VALUES
  ('22222222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Vorsitz',           'helios'),
  ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'Stellv. Vorsitz',   'helios'),
  ('22222222-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000002', 'Finanzreferent*in', 'helios'),
  ('22222222-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000003', 'IT-Referent*in',    'manual')
ON CONFLICT (id) DO NOTHING;

-- ── Committee members ─────────────────────────────────────────────────────────

INSERT INTO committee_members (id, committee_id, user_keycloak_id)
VALUES
  ('33333333-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000010'),
  ('33333333-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000009'),
  ('33333333-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000009'),
  ('33333333-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000010')
ON CONFLICT (id) DO NOTHING;

-- ── Role assignments (test.admin holds Vorsitz; test.member holds IT-Referent*in) ──

INSERT INTO role_assignments (id, role_id, user_keycloak_id, start_date, end_date, assigned_by_keycloak_id)
VALUES
  ('44444444-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000009', '2026-01-01', '2027-01-01', '55555555-0000-0000-0000-000000000009'),
  ('44444444-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000010', '2026-01-01', '2027-01-01', '55555555-0000-0000-0000-000000000009')
ON CONFLICT (id) DO NOTHING;
