CREATE TABLE investigations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status               text NOT NULL DEFAULT 'IN_PROGRESS'
                         CHECK (status IN ('IN_PROGRESS', 'CONFIRMED', 'INSUFFICIENT_EVIDENCE')),
  problem_description  text NOT NULL,
  slack_channel_id     text,
  slack_thread_ts      text,
  result               jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investigations_status_idx ON investigations (status);
