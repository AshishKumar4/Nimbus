CREATE TABLE IF NOT EXISTS demo_users (
  user_id TEXT PRIMARY KEY,
  cf_subject_hash TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'destroying', 'destroyed', 'failed')),
  destroyed_at INTEGER,
  destroy_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES demo_users(user_id)
);

CREATE INDEX IF NOT EXISTS demo_sessions_by_user
ON demo_sessions(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS demo_sessions_by_expiry
ON demo_sessions(status, expires_at);
