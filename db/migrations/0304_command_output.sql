-- runtime.commands is an S6 table (0200); these columns are an S7 change and
-- live in the S7 range 03xx by the master's decision (see docs/roadmap.md).
-- Plain SQL: the migration runner wraps the file in a transaction.

-- reason: the S3 ExitReason in lower case (S7 §9.6), so a command read
-- without the agent (sandbox stopped, command lost) still says why it ended.
-- output_truncated: "disk_full" when the agent dropped output of the command
-- (CommandExited/ExitEvent.output_truncated, output.truncated); null otherwise.
ALTER TABLE runtime.commands
  ADD COLUMN reason text CHECK (reason IN (
    'none', 'signal', 'timeout', 'oom', 'pty_idle', 'reboot', 'shim_lost', 'start_failed')),
  ADD COLUMN output_truncated text;
