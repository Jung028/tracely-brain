-- Module 08 (FR-35): migrate the placeholder 3-value status
-- (IN_PROGRESS | CONFIRMED | INSUFFICIENT_EVIDENCE, from module 07) to the
-- full 6-state lifecycle. Existing rows are dev data only (no production
-- users yet), so they're remapped in place. Constraint must be dropped
-- before the remap — Postgres validates ADD CONSTRAINT against existing
-- rows immediately, so adding the new CHECK before remapping old values
-- would fail on every existing row.

ALTER TABLE investigations
  DROP CONSTRAINT investigations_status_check;

UPDATE investigations SET status = 'INVESTIGATING' WHERE status = 'IN_PROGRESS';
UPDATE investigations SET status = 'RCA_IDENTIFIED' WHERE status = 'CONFIRMED';
UPDATE investigations SET status = 'MANUAL_REVIEW_REQUIRED' WHERE status = 'INSUFFICIENT_EVIDENCE';

ALTER TABLE investigations
  ADD CONSTRAINT investigations_status_check
    CHECK (status IN (
      'CREATED', 'INVESTIGATING', 'RCA_IDENTIFIED', 'MANUAL_REVIEW_REQUIRED',
      'RESOLUTION_PROPOSAL', 'RESOLVED'
    ));

ALTER TABLE investigations
  ALTER COLUMN status SET DEFAULT 'CREATED';

ALTER TABLE investigations
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0;
