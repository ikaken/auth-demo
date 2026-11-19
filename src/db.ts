// DB アクセスはすべてこのインターフェース越しに行う。
// Cloudflare 以外(Postgres など)に移す場合は Db を実装し直せばよい。
import type {
  ChallengeRow,
  CredentialRow,
  InviteRow,
  Member,
  MemberSummary,
} from './types';

export interface Db {
  // members
  countMembers(): Promise<number>;
  findMemberByEmail(email: string): Promise<Member | null>;
  findMemberById(id: string): Promise<Member | null>;
  insertMember(m: Member): Promise<void>;
  setMemberStatus(email: string, status: 'active' | 'disabled'): Promise<boolean>;
  listMembers(): Promise<MemberSummary[]>;
  // invites
  replaceInvite(tokenHash: string, memberId: string, now: number, expiresAt: number): Promise<void>;
  findInvite(tokenHash: string): Promise<InviteRow | null>;
  /** 未使用なら使用済みにして true。すでに使用済みなら false (レース防止) */
  consumeInvite(tokenHash: string, now: number): Promise<boolean>;
  /** 検証に失敗したとき、招待を未使用に戻す */
  restoreInvite(tokenHash: string): Promise<void>;
  // challenges
  saveChallenge(c: ChallengeRow): Promise<void>;
  /** 取得と同時に削除する (1回限り) */
  takeChallenge(id: string): Promise<ChallengeRow | null>;
  // credentials
  insertCredential(c: CredentialRow): Promise<void>;
  findCredential(id: string): Promise<CredentialRow | null>;
  listCredentials(memberId: string): Promise<CredentialRow[]>;
  touchCredential(id: string, counter: number, now: number): Promise<void>;
  renameCredential(id: string, memberId: string, name: string): Promise<boolean>;
  /** 最後の1つは削除しない。削除できたら true */
  deleteCredential(id: string, memberId: string): Promise<boolean>;
  // sessions
  createSession(idHash: string, memberId: string, now: number, expiresAt: number): Promise<void>;
  findSessionMember(idHash: string, now: number): Promise<Member | null>;
  deleteSession(idHash: string): Promise<void>;
  deleteSessionsOfMember(memberId: string): Promise<void>;
  // rate limit
  hit(key: string, now: number, windowSec: number): Promise<number>;
  // maintenance
  purge(now: number): Promise<void>;
}

export class D1Db implements Db {
  constructor(private d1: D1Database) {}

  async countMembers() {
    const r = await this.d1.prepare('SELECT COUNT(*) AS n FROM members').first<{ n: number }>();
    return r?.n ?? 0;
  }
  findMemberByEmail(email: string) {
    return this.d1.prepare('SELECT * FROM members WHERE email = ?').bind(email).first<Member>();
  }
  findMemberById(id: string) {
    return this.d1.prepare('SELECT * FROM members WHERE id = ?').bind(id).first<Member>();
  }
  async insertMember(m: Member) {
    await this.d1
      .prepare('INSERT INTO members (id, email, user_handle, status, created_at) VALUES (?,?,?,?,?)')
      .bind(m.id, m.email, m.user_handle, m.status, m.created_at)
      .run();
  }
  async setMemberStatus(email: string, status: 'active' | 'disabled') {
    const r = await this.d1.prepare('UPDATE members SET status = ? WHERE email = ?').bind(status, email).run();
    return (r.meta.changes ?? 0) > 0;
  }
  async listMembers() {
    const r = await this.d1
      .prepare(
        `SELECT m.email, m.status, m.created_at,
                (SELECT COUNT(*) FROM credentials c WHERE c.member_id = m.id) AS passkeys
         FROM members m ORDER BY m.email`,
      )
      .all<MemberSummary>();
    return r.results;
  }

  async replaceInvite(tokenHash: string, memberId: string, now: number, expiresAt: number) {
    await this.d1.batch([
      this.d1.prepare('DELETE FROM invites WHERE member_id = ?').bind(memberId),
      this.d1
        .prepare('INSERT INTO invites (token_hash, member_id, expires_at, created_at) VALUES (?,?,?,?)')
        .bind(tokenHash, memberId, expiresAt, now),
    ]);
  }
  findInvite(tokenHash: string) {
    return this.d1
      .prepare('SELECT token_hash, member_id, expires_at, used_at FROM invites WHERE token_hash = ?')
      .bind(tokenHash)
      .first<InviteRow>();
  }
  async consumeInvite(tokenHash: string, now: number) {
    const r = await this.d1
      .prepare('UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .bind(now, tokenHash, now)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async restoreInvite(tokenHash: string) {
    await this.d1.prepare('UPDATE invites SET used_at = NULL WHERE token_hash = ?').bind(tokenHash).run();
  }

  async saveChallenge(c: ChallengeRow) {
    await this.d1
      .prepare('INSERT INTO challenges (id, challenge, purpose, member_id, expires_at) VALUES (?,?,?,?,?)')
      .bind(c.id, c.challenge, c.purpose, c.member_id, c.expires_at)
      .run();
  }
  takeChallenge(id: string) {
    return this.d1.prepare('DELETE FROM challenges WHERE id = ? RETURNING *').bind(id).first<ChallengeRow>();
  }

  async insertCredential(c: CredentialRow) {
    await this.d1
      .prepare(
        `INSERT INTO credentials (id, member_id, public_key, counter, transports, device_type, backed_up, name, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(c.id, c.member_id, c.public_key, c.counter, c.transports, c.device_type, c.backed_up, c.name, c.created_at)
      .run();
  }
  findCredential(id: string) {
    return this.d1.prepare('SELECT * FROM credentials WHERE id = ?').bind(id).first<CredentialRow>();
  }
  async listCredentials(memberId: string) {
    const r = await this.d1
      .prepare('SELECT * FROM credentials WHERE member_id = ? ORDER BY created_at')
      .bind(memberId)
      .all<CredentialRow>();
    return r.results;
  }
  async touchCredential(id: string, counter: number, now: number) {
    await this.d1.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?').bind(counter, now, id).run();
  }
  async renameCredential(id: string, memberId: string, name: string) {
    const r = await this.d1
      .prepare('UPDATE credentials SET name = ? WHERE id = ? AND member_id = ?')
      .bind(name, id, memberId)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }
  async deleteCredential(id: string, memberId: string) {
    const r = await this.d1
      .prepare(
        `DELETE FROM credentials
         WHERE id = ? AND member_id = ?
           AND (SELECT COUNT(*) FROM credentials WHERE member_id = ?) > 1`,
      )
      .bind(id, memberId, memberId)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async createSession(idHash: string, memberId: string, now: number, expiresAt: number) {
    await this.d1
      .prepare('INSERT INTO sessions (id_hash, member_id, expires_at, created_at) VALUES (?,?,?,?)')
      .bind(idHash, memberId, expiresAt, now)
      .run();
  }
  findSessionMember(idHash: string, now: number) {
    return this.d1
      .prepare(
        `SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id
         WHERE s.id_hash = ? AND s.expires_at > ?`,
      )
      .bind(idHash, now)
      .first<Member>();
  }
  async deleteSession(idHash: string) {
    await this.d1.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run();
  }
  async deleteSessionsOfMember(memberId: string) {
    await this.d1.prepare('DELETE FROM sessions WHERE member_id = ?').bind(memberId).run();
  }

  async hit(key: string, now: number, windowSec: number) {
    const r = await this.d1
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN window_start <= ?2 - ?3 THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END
         RETURNING count`,
      )
      .bind(key, now, windowSec)
      .first<{ count: number }>();
    return r?.count ?? 1;
  }

  async purge(now: number) {
    await this.d1.batch([
      this.d1.prepare('DELETE FROM challenges WHERE expires_at <= ?').bind(now),
      this.d1.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
      this.d1.prepare('DELETE FROM invites WHERE expires_at <= ? AND used_at IS NULL').bind(now),
      this.d1.prepare('DELETE FROM rate_limits WHERE window_start <= ?').bind(now - 86400),
    ]);
  }
}
