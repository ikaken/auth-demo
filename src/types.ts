export interface Env {
  DB: D1Database;
  /** パスキーの紐づけ先ドメイン。例: auth-demo.ikaken.com (開発時は localhost) */
  RP_ID: string;
  RP_NAME: string;
  /** 期待するオリジン。例: https://auth-demo.ikaken.com */
  ORIGIN: string;
  /** 管理 API 用の Bearer トークン (secret)。未設定なら管理 API は無効 */
  ADMIN_TOKEN?: string;
  MAX_MEMBERS: string;
  INVITE_TTL_HOURS: string;
  SESSION_TTL_DAYS: string;
}

export interface Member {
  id: string;
  email: string;
  user_handle: string;
  status: 'active' | 'disabled';
  created_at: number;
}

export interface CredentialRow {
  id: string;
  member_id: string;
  public_key: string;
  counter: number;
  transports: string;
  device_type: string;
  backed_up: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export interface InviteRow {
  token_hash: string;
  member_id: string;
  expires_at: number;
  used_at: number | null;
}

export interface ChallengeRow {
  id: string;
  challenge: string;
  purpose: 'register' | 'add' | 'login';
  member_id: string | null;
  expires_at: number;
}

export interface MemberSummary {
  email: string;
  status: string;
  passkeys: number;
  created_at: number;
}
