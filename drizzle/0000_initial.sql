CREATE TYPE debate_status AS ENUM ('queued', 'framing', 'researching', 'debating', 'judging', 'complete', 'failed', 'partial');
CREATE TYPE topic_kind AS ENUM ('policy', 'value', 'empirical', 'decision', 'comparison');
CREATE TYPE perspective_side AS ENUM ('pro', 'con', 'neutral');

CREATE TABLE debates (
  id varchar(48) PRIMARY KEY,
  subject text NOT NULL,
  context text,
  mode varchar(32) NOT NULL DEFAULT 'hybrid_council',
  evidence varchar(32) NOT NULL DEFAULT 'cited',
  status debate_status NOT NULL DEFAULT 'queued',
  resolution text NOT NULL,
  topic_kind topic_kind NOT NULL,
  high_stakes jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE debate_runs (
  id varchar(48) PRIMARY KEY,
  debate_id varchar(48) NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  status debate_status NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  trace jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE agent_runs (
  id varchar(48) PRIMARY KEY,
  run_id varchar(48) NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  name text NOT NULL,
  side perspective_side NOT NULL,
  role text NOT NULL,
  model text NOT NULL,
  thesis text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE evidence_sources (
  id varchar(48) PRIMARY KEY,
  run_id varchar(48) NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  title text NOT NULL,
  url text NOT NULL,
  publisher text NOT NULL,
  published_at text,
  snippet text NOT NULL,
  quality varchar(32) NOT NULL,
  retrieved_via varchar(32) NOT NULL,
  status varchar(32) NOT NULL
);

CREATE UNIQUE INDEX evidence_sources_run_url_idx ON evidence_sources(run_id, url);

CREATE TABLE claims (
  id varchar(48) PRIMARY KEY,
  run_id varchar(48) NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  side perspective_side NOT NULL,
  text text NOT NULL,
  warrant text NOT NULL,
  evidence_source_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence double precision NOT NULL
);

CREATE TABLE argument_nodes (
  id varchar(64) PRIMARY KEY,
  run_id varchar(48) NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,
  side perspective_side NOT NULL,
  label text NOT NULL,
  detail text NOT NULL,
  source_id varchar(48)
);

CREATE TABLE round_turns (
  id varchar(48) PRIMARY KEY,
  run_id varchar(48) NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  round varchar(48) NOT NULL,
  agent_id varchar(48) NOT NULL,
  agent_name text NOT NULL,
  side perspective_side NOT NULL,
  content text NOT NULL,
  claim_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scorecards (
  id varchar(48) PRIMARY KEY,
  run_id varchar(48) NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  recommendation varchar(48) NOT NULL,
  confidence double precision NOT NULL,
  categories jsonb NOT NULL
);

CREATE TABLE summaries (
  id varchar(48) PRIMARY KEY,
  run_id varchar(48) NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  headline text NOT NULL,
  recommendation text NOT NULL,
  strongest_pro jsonb NOT NULL DEFAULT '[]'::jsonb,
  strongest_con jsonb NOT NULL DEFAULT '[]'::jsonb,
  unresolved_uncertainties jsonb NOT NULL DEFAULT '[]'::jsonb,
  what_would_change_mind jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence double precision NOT NULL,
  high_stakes_disclaimer text
);

CREATE TABLE model_snapshots (
  id varchar(64) PRIMARY KEY,
  run_id varchar(48) NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  provider varchar(32) NOT NULL,
  model text NOT NULL,
  role text NOT NULL,
  configured boolean NOT NULL DEFAULT false,
  latency_ms integer,
  prompt_tokens integer,
  completion_tokens integer,
  estimated_cost_usd double precision,
  failure text
);

CREATE TABLE product_notes (
  id varchar(64) PRIMARY KEY,
  title text NOT NULL,
  mode varchar(48) NOT NULL,
  note text NOT NULL,
  priority varchar(32) NOT NULL
);
