-- gremion-ui/migrations/033_org_unit_child_term.sql
-- WI-3: admin-editable label for a node's children in the Gremien tree.
-- Meaningful on council/top-level rows (e.g. "Referate", "Arbeitsgruppen");
-- NULL elsewhere -> the render falls back to a computed default.
-- Spec: docs/planning/2026-05-31-v6-design-coupled-spec.md §5.
-- Inverse: ALTER TABLE org_units DROP COLUMN child_term;

ALTER TABLE org_units ADD COLUMN child_term TEXT;
