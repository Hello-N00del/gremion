-- P0.4 NEGATIVE FIXTURE — never apply. A new finance-schema table with an
-- (unqualified ⇒ public) FK onto org_units: exactly the R-FK violation class.
CREATE TABLE finance.lint_violation_probe (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_unit_id UUID NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT
);
