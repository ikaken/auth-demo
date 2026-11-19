-- 許可リスト(利用を許可したメンバー)。email は小文字に正規化して保存する
CREATE TABLE members (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  user_handle TEXT NOT NULL UNIQUE,            -- WebAuthn user.id (ランダム32バイト, base64url)。メールとは無関係な値にする
  status      TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  created_at  INTEGER NOT NULL
);

-- パスキー(公開鍵)。1メンバーが複数持てる
CREATE TABLE credentials (
  id           TEXT PRIMARY KEY,               -- credential ID (base64url)
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  public_key   TEXT NOT NULL,                  -- base64url
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT NOT NULL DEFAULT '[]',     -- JSON 配列
  device_type  TEXT NOT NULL,                  -- singleDevice | multiDevice
  backed_up    INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_credentials_member ON credentials(member_id);

-- 招待(1回限り・期限付き)。トークン本体は保存せず SHA-256 のみ保存する
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_invites_member ON invites(member_id);

-- WebAuthn チャレンジ(1回限り・短命)
CREATE TABLE challenges (
  id         TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,
  purpose    TEXT NOT NULL,                    -- register | add | login
  member_id  TEXT,
  expires_at INTEGER NOT NULL
);

-- セッション。ID 本体は保存せず SHA-256 のみ保存する
CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_member ON sessions(member_id);

-- 固定窓レート制限
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
