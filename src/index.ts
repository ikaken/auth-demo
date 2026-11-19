import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { D1Db, type Db } from './db';
import { randomToken, safeEqual, sha256Hex } from './crypto';
import type { ChallengeRow, Env, Member } from './types';

type AppEnv = { Bindings: Env; Variables: { db: Db; member: Member; sessionHash: string } };
type Ctx = Context<AppEnv>;

const CHALLENGE_TTL_SEC = 300;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const now = () => Math.floor(Date.now() / 1000);
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const isHttps = (env: Env) => env.ORIGIN.startsWith('https://');
const sessionCookieName = (env: Env) => (isHttps(env) ? '__Host-session' : 'session');

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// 共通ミドルウェア
// ---------------------------------------------------------------------------
app.use('/api/*', async (c, next) => {
  c.set('db', new D1Db(c.env.DB));
  c.header('Cache-Control', 'no-store');
  await next();
});

// CSRF 対策: 状態を変える API は Origin が自サイトのときだけ受け付ける (管理 API は Bearer 認証のため対象外)
app.use('/api/*', async (c, next) => {
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (!safe && !c.req.path.startsWith('/api/admin/') && c.req.header('Origin') !== c.env.ORIGIN) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await next();
});

/** クライアント IP。Cloudflare 以外に移す場合はここを差し替える */
const clientIp = (c: Ctx) => c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'local';

/** 固定窓のレート制限。超過したら 429 の Response を返す */
async function limited(c: Ctx, name: string, limit: number, windowSec: number): Promise<Response | null> {
  const count = await c.var.db.hit(`${name}:${clientIp(c)}`, now(), windowSec);
  return count > limit ? c.json({ error: 'too_many_requests' }, 429) : null;
}

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const str = (v: unknown, max = 2048) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

// ---------------------------------------------------------------------------
// セッション
// ---------------------------------------------------------------------------
async function startSession(c: Ctx, member: Member) {
  const token = randomToken(32);
  const ttl = num(c.env.SESSION_TTL_DAYS, 7) * 86400;
  await c.var.db.createSession(await sha256Hex(token), member.id, now(), now() + ttl);
  setCookie(c, sessionCookieName(c.env), token, {
    httpOnly: true,
    secure: isHttps(c.env),
    sameSite: 'Lax',
    path: '/',
    maxAge: ttl,
  });
}

const requireSession = async (c: Ctx, next: () => Promise<void>) => {
  const token = getCookie(c, sessionCookieName(c.env));
  if (token) {
    const hash = await sha256Hex(token);
    const member = await c.var.db.findSessionMember(hash, now());
    if (member && member.status === 'active') {
      c.set('member', member);
      c.set('sessionHash', hash);
      return next();
    }
  }
  return c.json({ error: 'unauthorized' }, 401);
};

// ---------------------------------------------------------------------------
// WebAuthn 共通処理
// ---------------------------------------------------------------------------
async function newChallengeId(c: Ctx, purpose: ChallengeRow['purpose'], challenge: string, memberId: string | null) {
  const id = randomToken(24);
  await c.var.db.saveChallenge({ id, challenge, purpose, member_id: memberId, expires_at: now() + CHALLENGE_TTL_SEC });
  return id;
}

async function registrationOptionsFor(c: Ctx, member: Member, purpose: 'register' | 'add', remoteDevice = false) {
  const existing = await c.var.db.listCredentials(member.id);
  const options = await generateRegistrationOptions({
    // スマホ・タブレットに作る場合: ブラウザに QR コード(ハイブリッド転送)の画面を直接開かせる
    ...(remoteDevice ? { preferredAuthenticatorType: 'remoteDevice' as const } : {}),
    rpName: c.env.RP_NAME,
    rpID: c.env.RP_ID,
    userName: member.email,
    userDisplayName: member.email,
    userID: isoBase64URL.toBuffer(member.user_handle),
    attestationType: 'none',
    excludeCredentials: existing.map((x) => ({
      id: x.id,
      transports: JSON.parse(x.transports) as AuthenticatorTransportFuture[],
    })),
    // パスキー(Discoverable credential)を必須にし、端末での本人確認(生体認証/PIN)も必須にする
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = await newChallengeId(c, purpose, options.challenge, member.id);
  return c.json({ challengeId, options });
}

/** 登録レスポンスを検証してパスキーを保存する。失敗時は false */
async function verifyAndStoreCredential(
  c: Ctx,
  member: Member,
  purpose: 'register' | 'add',
  challengeId: string,
  response: RegistrationResponseJSON,
): Promise<boolean> {
  const ch = await c.var.db.takeChallenge(challengeId);
  if (!ch || ch.purpose !== purpose || ch.member_id !== member.id || ch.expires_at <= now()) return false;

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: c.env.ORIGIN,
      expectedRPID: c.env.RP_ID,
      requireUserVerification: true,
    });
  } catch {
    return false;
  }
  if (!verification.verified || !verification.registrationInfo) return false;

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const date = new Date().toISOString().slice(0, 10);
  await c.var.db.insertCredential({
    id: credential.id,
    member_id: member.id,
    public_key: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: JSON.stringify(credential.transports ?? response.response.transports ?? []),
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp ? 1 : 0,
    name: `${c.env.RP_NAME}パスキー ${date}`,
    created_at: now(),
    last_used_at: null,
  });
  return true;
}

// ---------------------------------------------------------------------------
// 招待経由の初回登録
// ---------------------------------------------------------------------------
async function memberForInvite(c: Ctx, token: string): Promise<Member | null> {
  const invite = await c.var.db.findInvite(await sha256Hex(token));
  if (!invite || invite.used_at !== null || invite.expires_at <= now()) return null;
  const member = await c.var.db.findMemberById(invite.member_id);
  return member && member.status === 'active' ? member : null;
}

app.post('/api/register/options', async (c) => {
  const limit = await limited(c, 'reg-opt', 20, 600);
  if (limit) return limit;
  const token = str((await readJson(c)).token, 200);
  const member = token ? await memberForInvite(c, token) : null;
  if (!member) return c.json({ error: 'invalid_invite' }, 400);
  return registrationOptionsFor(c, member, 'register');
});

app.post('/api/register/verify', async (c) => {
  const limit = await limited(c, 'reg-verify', 20, 600);
  if (limit) return limit;
  const body = await readJson(c);
  const token = str(body.token, 200);
  const challengeId = str(body.challengeId, 100);
  const member = token ? await memberForInvite(c, token) : null;
  if (!token || !challengeId || !member || typeof body.response !== 'object' || !body.response) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  // 招待を先に消費する(同じ招待での同時登録を防ぐ)。検証に失敗したら未使用に戻す
  const tokenHash = await sha256Hex(token);
  if (!(await c.var.db.consumeInvite(tokenHash, now()))) {
    return c.json({ error: 'invalid_invite' }, 400);
  }
  const ok = await verifyAndStoreCredential(c, member, 'register', challengeId, body.response as RegistrationResponseJSON);
  if (!ok) {
    await c.var.db.restoreInvite(tokenHash);
    return c.json({ error: 'verification_failed' }, 400);
  }
  await startSession(c, member);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ログイン (ユーザー名なし: パスキーが本人とメンバーを特定する)
// ---------------------------------------------------------------------------
app.post('/api/login/options', async (c) => {
  const limit = await limited(c, 'login-opt', 60, 600);
  if (limit) return limit;
  if (Math.random() < 0.05) await c.var.db.purge(now());
  const options = await generateAuthenticationOptions({ rpID: c.env.RP_ID, userVerification: 'required' });
  const challengeId = await newChallengeId(c, 'login', options.challenge, null);
  return c.json({ challengeId, options });
});

app.post('/api/login/verify', async (c) => {
  const limit = await limited(c, 'login-verify', 30, 600);
  if (limit) return limit;
  const body = await readJson(c);
  const challengeId = str(body.challengeId, 100);
  const response = body.response as AuthenticationResponseJSON | undefined;
  const fail = () => c.json({ error: 'login_failed' }, 401);
  if (!challengeId || !response || typeof response.id !== 'string') return fail();

  const ch = await c.var.db.takeChallenge(challengeId);
  if (!ch || ch.purpose !== 'login' || ch.expires_at <= now()) return fail();

  const cred = await c.var.db.findCredential(response.id);
  if (!cred) return fail();
  const member = await c.var.db.findMemberById(cred.member_id);
  if (!member || member.status !== 'active') return fail();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: c.env.ORIGIN,
      expectedRPID: c.env.RP_ID,
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: isoBase64URL.toBuffer(cred.public_key),
        counter: cred.counter,
        transports: JSON.parse(cred.transports) as AuthenticatorTransportFuture[],
      },
    });
  } catch {
    return fail();
  }
  if (!verification.verified) return fail();

  await c.var.db.touchCredential(cred.id, verification.authenticationInfo.newCounter, now());
  await startSession(c, member);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ログイン後: アカウント / パスキー管理
// ---------------------------------------------------------------------------
app.get('/api/me', requireSession, (c) => c.json({ email: c.var.member.email }));

app.post('/api/logout', requireSession, async (c) => {
  await c.var.db.deleteSession(c.var.sessionHash);
  deleteCookie(c, sessionCookieName(c.env), { path: '/', secure: isHttps(c.env) });
  return c.json({ ok: true });
});

app.get('/api/passkeys', requireSession, async (c) => {
  const rows = await c.var.db.listCredentials(c.var.member.id);
  return c.json({
    passkeys: rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      synced: r.device_type === 'multiDevice',
      backedUp: r.backed_up === 1,
    })),
  });
});

app.post('/api/passkeys/options', requireSession, async (c) => {
  const limit = await limited(c, 'add-opt', 20, 600);
  if (limit) return limit;
  // target: 'phone' ならスマホ・タブレット向け(QR コード)。それ以外はブラウザの標準の選択画面
  const target = (await readJson(c)).target;
  return registrationOptionsFor(c, c.var.member, 'add', target === 'phone');
});

app.post('/api/passkeys/verify', requireSession, async (c) => {
  const limit = await limited(c, 'add-verify', 20, 600);
  if (limit) return limit;
  const body = await readJson(c);
  const challengeId = str(body.challengeId, 100);
  if (!challengeId || typeof body.response !== 'object' || !body.response) return c.json({ error: 'invalid_request' }, 400);
  const ok = await verifyAndStoreCredential(c, c.var.member, 'add', challengeId, body.response as RegistrationResponseJSON);
  return ok ? c.json({ ok: true }) : c.json({ error: 'verification_failed' }, 400);
});

app.patch('/api/passkeys/:id', requireSession, async (c) => {
  const name = str((await readJson(c)).name, 60)?.trim();
  if (!name) return c.json({ error: 'invalid_name' }, 400);
  const ok = await c.var.db.renameCredential(c.req.param('id') ?? '', c.var.member.id, name);
  return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
});

app.delete('/api/passkeys/:id', requireSession, async (c) => {
  const ok = await c.var.db.deleteCredential(c.req.param('id') ?? '', c.var.member.id);
  // 存在しない、または最後の1つのため削除できない
  return ok ? c.json({ ok: true }) : c.json({ error: 'cannot_delete' }, 409);
});

// ---------------------------------------------------------------------------
// 管理 API (Bearer ADMIN_TOKEN)。許可リスト管理と招待リンク発行
// ---------------------------------------------------------------------------
app.use('/api/admin/*', async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return c.json({ error: 'admin_disabled' }, 503);
  const limit = await limited(c, 'admin', 120, 600);
  if (limit) return limit;
  const given = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1] ?? '';
  if (!(await safeEqual(given, expected))) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

const normalizeEmail = (v: unknown) => {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
};

app.get('/api/admin/members', async (c) => c.json({ members: await c.var.db.listMembers() }));

app.post('/api/admin/members', async (c) => {
  const emails = (await readJson(c)).emails;
  if (!Array.isArray(emails) || emails.length > 500) return c.json({ error: 'invalid_request' }, 400);
  const max = num(c.env.MAX_MEMBERS, 50);
  const added: string[] = [];
  const existing: string[] = [];
  const rejected: string[] = [];
  let total = await c.var.db.countMembers();
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!email) {
      rejected.push(String(raw));
      continue;
    }
    if (await c.var.db.findMemberByEmail(email)) {
      existing.push(email);
      continue;
    }
    if (total >= max) {
      rejected.push(`${email} (上限 ${max} 人)`);
      continue;
    }
    await c.var.db.insertMember({
      id: randomToken(16),
      email,
      user_handle: randomToken(32),
      status: 'active',
      created_at: now(),
    });
    total++;
    added.push(email);
  }
  return c.json({ added, existing, rejected });
});

for (const [path, status] of [
  ['disable', 'disabled'],
  ['enable', 'active'],
] as const) {
  app.post(`/api/admin/members/${path}`, async (c) => {
    const email = normalizeEmail((await readJson(c)).email);
    if (!email) return c.json({ error: 'invalid_request' }, 400);
    const member = await c.var.db.findMemberByEmail(email);
    if (!member) return c.json({ error: 'not_found' }, 404);
    await c.var.db.setMemberStatus(email, status);
    if (status === 'disabled') await c.var.db.deleteSessionsOfMember(member.id);
    return c.json({ ok: true });
  });
}

/** 招待リンクを発行する (再発行すると以前の未使用リンクは無効になる)。パスキーを紛失したメンバーの復旧にも使う */
app.post('/api/admin/invites', async (c) => {
  const email = normalizeEmail((await readJson(c)).email);
  if (!email) return c.json({ error: 'invalid_request' }, 400);
  const member = await c.var.db.findMemberByEmail(email);
  if (!member || member.status !== 'active') return c.json({ error: 'not_found' }, 404);
  const token = randomToken(32);
  const expiresAt = now() + num(c.env.INVITE_TTL_HOURS, 48) * 3600;
  await c.var.db.replaceInvite(await sha256Hex(token), member.id, now(), expiresAt);
  // トークンは URL フラグメントに入れる (サーバーログやリファラーに残らない)
  return c.json({ email, url: `${c.env.ORIGIN}/register.html#token=${token}`, expiresAt });
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

export default app;
