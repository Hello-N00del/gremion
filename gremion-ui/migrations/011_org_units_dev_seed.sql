-- 011_org_units_dev_seed.sql
-- Dev sample org-unit tree. Guarded: only seeds when no org_units exist, so it
-- is a no-op on any database that already has data.

INSERT INTO org_units (id, name, description, parent_id, kind, visibility,
                       wants_matrix_room, wants_nextcloud_folder)
SELECT * FROM (VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'StuRa (Demo)', 'Beispiel-Rat',
   NULL::uuid, 'council', 'all_members', true, true),
  ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'Vorstand (Demo)', 'Beispiel-Gremium',
   'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'committee', 'all_members', true, true),
  ('aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'IT-Team (Demo)', 'Beispiel-Gruppe',
   'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'group', 'committee_only', true, false)
) AS seed (id, name, description, parent_id, kind, visibility,
           wants_matrix_room, wants_nextcloud_folder)
WHERE NOT EXISTS (SELECT 1 FROM org_units);
