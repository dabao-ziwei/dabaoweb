PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admins(
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
 token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id), csrf TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_challenges(token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, failures INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS courses(
 id TEXT PRIMARY KEY, draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
 published_json TEXT CHECK(published_json IS NULL OR json_valid(published_json)),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS cohorts(
 id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)), published_json TEXT CHECK(published_json IS NULL OR json_valid(published_json)),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS media(
 id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, source_sha256 TEXT NOT NULL,
 width INTEGER NOT NULL CHECK(width>0), height INTEGER NOT NULL CHECK(height>0),
 original_mime TEXT NOT NULL, bytes INTEGER NOT NULL, original_name TEXT NOT NULL,
 source_url TEXT UNIQUE, created_at TEXT NOT NULL, created_by TEXT
);
CREATE TABLE IF NOT EXISTS feedback(
 id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)), published_json TEXT CHECK(published_json IS NULL OR json_valid(published_json)),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS settings(
 id TEXT PRIMARY KEY CHECK(id='site'), draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
 published_json TEXT CHECK(published_json IS NULL OR json_valid(published_json)),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS versions(id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_json TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS audit_recent ON audit_log(id DESC);
INSERT OR IGNORE INTO schema_migrations VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
