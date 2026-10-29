-- Idle-stop (S6 §12): when the agent's activity counters last became all zero.
-- Set by the machine-events handler on an `activity` event that reports all
-- zeros while it was null; cleared on any non-zero report. Plain SQL: the
-- migration runner wraps the file in a transaction.

ALTER TABLE runtime.sandboxes ADD COLUMN activity_zero_since timestamptz;
