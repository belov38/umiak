-- Tickets contain identifiers/deadlines only; sandbox secrets remain encrypted.
CREATE TABLE runtime.start_queue (
 operation_id uuid PRIMARY KEY REFERENCES runtime.operations(id),
 team_id uuid NOT NULL,
 seq bigserial NOT NULL UNIQUE,
 deadline_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX start_queue_team_fifo ON runtime.start_queue(team_id,seq);
