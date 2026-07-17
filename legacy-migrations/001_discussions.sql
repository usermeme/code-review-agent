CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS discussions (
  id         BIGSERIAL PRIMARY KEY,
  repo       TEXT NOT NULL,
  pr_number  INTEGER,
  source     TEXT NOT NULL, -- issue_comment | review_comment | review | bot_finding
  author     TEXT NOT NULL,
  file_path  TEXT,
  body       TEXT NOT NULL,
  provider_id TEXT UNIQUE,
  platform_installation_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  embedding  vector(1536) NOT NULL
);

CREATE INDEX IF NOT EXISTS discussions_repo_idx ON discussions (repo);
CREATE INDEX IF NOT EXISTS discussions_embedding_idx ON discussions
  USING hnsw (embedding vector_cosine_ops);
