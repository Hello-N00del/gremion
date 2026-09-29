-- lifecycle fixture module lcfix, 001: two tables carrying a customer column
-- each (customer_id, tenant_id), so the TRD-089 inspection has columns to read.
CREATE TABLE item (
  item_id     uuid PRIMARY KEY DEFAULT uuidv7(),
  customer_id uuid NOT NULL,
  note        text NOT NULL
);

CREATE TABLE audit (
  audit_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
