CREATE TABLE debate_records (
  id varchar(48) PRIMARY KEY,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
