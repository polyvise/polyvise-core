CREATE TABLE user_feedback (
  id varchar(48) PRIMARY KEY,
  app varchar(64) NOT NULL,
  message text NOT NULL,
  debate_id varchar(48),
  page_path text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
