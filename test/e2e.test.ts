// 結合テスト: 起動中の開発サーバー (`npm run dev`) に対して、ソフトウェア認証器で
// 招待 → 登録 → ログイン → パスキー管理 → 利用停止 までを通す。
//
//   ADMIN_TOKEN=dev-admin-token-change-me npm test        (BASE_URL 既定は http://localhost:8787)
//
// 前提: .dev.vars の RP_ID=localhost / ORIGIN=http://localhost:8787
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const ORIGIN = process.env.TEST_ORIGIN ?? BASE;
const RP_ID = new URL(ORIGIN).hostname;
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin-token-change-me';
const RUN = randomBytes(4).toString('hex'); // 実行ごとにレート制限の鍵とメールを分ける

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | Buffer | string) => createHash('sha256').update(b).digest();

// ---- 最小限の CBOR エンコーダ(整数・バイト列・文字列・Map のみ) ----
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) {
    return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  }
  throw new Error('unsupported');
}

// ---- ソフトウェア認証器 (ES256 / none attestation) ----
class FakeAuthenticator {
  credId = randomBytes(32);
  counter = 0;
  userHandle: string | null = null;
  private privateKey: KeyObject;
  private x: Buffer;
  private y: Buffer;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.x = Buffer.from(jwk.x!, 'base64url');
    this.y = Buffer.from(jwk.y!, 'base64url');
  }
  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  register(options: any, origin = ORIGIN) {
    assert.equal(options.authenticatorSelection.residentKey, 'required');
    assert.equal(options.authenticatorSelection.userVerification, 'required');
    this.userHandle = options.user.id;
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]));
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([
      sha256(RP_ID), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, this.credId, cose,
    ]);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge, origin)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    };
  }
  authenticate(options: any, { origin = ORIGIN, tamper = false } = {}) {
    this.counter += 1;
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), cnt]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, origin);
    const sig = createSign('sha256').update(Buffer.concat([authData, sha256(clientDataJSON)])).sign(this.privateKey);
    if (tamper) sig[sig.length - 1] ^= 0xff;
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig),
        userHandle: this.userHandle,
      },
    };
  }
}

// ---- HTTP クライアント (Cookie を保持) ----
class Client {
  cookies = new Map<string, string>();
  async call(path: string, { method = 'GET', body, origin = ORIGIN as string | null, headers = {} as Record<string, string> } = {}) {
    const h: Record<string, string> = { 'X-Forwarded-For': `test-${RUN}`, ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (origin) h['Origin'] = origin;
    if (this.cookies.size) h['Cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair = ''] = sc.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/max-age=0/i.test(sc) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    let data: any = {};
    try { data = await res.json(); } catch { /* ignore */ }
    return { status: res.status, data, headers: res.headers };
  }
  admin(path: string, method = 'GET', body?: unknown, token = ADMIN) {
    return this.call(path, { method, body, origin: null, headers: { Authorization: `Bearer ${token}` } });
  }
}

const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;

test('許可リスト招待制のパスキー認証フロー', async (t) => {
  const aliceMail = `alice+${RUN}@example.com`;
  const bobMail = `bob+${RUN}@example.com`;
  const admin = new Client();
  const alice = new Client();
  const aliceKey = new FakeAuthenticator();

  await t.test('管理 API: トークンなし/誤りは 401', async () => {
    assert.equal((await admin.call('/api/admin/members', { origin: null })).status, 401);
    assert.equal((await admin.admin('/api/admin/members', 'GET', undefined, 'wrong')).status, 401);
  });

  await t.test('許可リスト登録: 不正なメールは除外される', async () => {
    const r = await admin.admin('/api/admin/members', 'POST', { emails: [aliceMail, bobMail, 'not-an-email', aliceMail.toUpperCase()] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.added.sort(), [aliceMail, bobMail].sort());
    assert.equal(r.data.rejected.length, 1);
    assert.deepEqual(r.data.existing, [aliceMail]); // 大文字小文字は同一視
  });

  await t.test('許可リスト外のメールには招待を発行できない', async () => {
    assert.equal((await admin.admin('/api/admin/invites', 'POST', { email: `stranger+${RUN}@example.com` })).status, 404);
  });

  await t.test('不正な招待トークンでは登録できない', async () => {
    assert.equal((await alice.call('/api/register/options', { method: 'POST', body: { token: 'bogus' } })).status, 400);
  });

  let inviteUrl = '';
  await t.test('招待発行 → 登録 → セッション開始', async () => {
    const inv = await admin.admin('/api/admin/invites', 'POST', { email: aliceMail });
    assert.equal(inv.status, 200);
    inviteUrl = inv.data.url;
    assert.ok(inviteUrl.startsWith(`${ORIGIN}/register.html#token=`));
    const token = tokenOf(inviteUrl);

    const opt = await alice.call('/api/register/options', { method: 'POST', body: { token } });
    assert.equal(opt.status, 200);
    assert.equal(opt.data.options.user.name, aliceMail);
    assert.equal(opt.data.options.rp.id, RP_ID);
    const res = await alice.call('/api/register/verify', {
      method: 'POST', body: { token, challengeId: opt.data.challengeId, response: aliceKey.register(opt.data.options) },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal((await alice.call('/api/me')).data.email, aliceMail);
  });

  await t.test('使用済みの招待は再利用できない', async () => {
    const r = await new Client().call('/api/register/options', { method: 'POST', body: { token: tokenOf(inviteUrl) } });
    assert.equal(r.status, 400);
  });

  await t.test('登録検証に失敗しても招待は未使用に戻る(オリジン不一致)', async () => {
    const bob = new Client();
    const token = tokenOf((await admin.admin('/api/admin/invites', 'POST', { email: bobMail })).data.url);
    const bobKey = new FakeAuthenticator();
    let opt = await bob.call('/api/register/options', { method: 'POST', body: { token } });
    const bad = await bob.call('/api/register/verify', {
      method: 'POST',
      body: { token, challengeId: opt.data.challengeId, response: bobKey.register(opt.data.options, 'https://evil.example') },
    });
    assert.equal(bad.status, 400);
    assert.equal(bob.cookies.size, 0);
    // 同じ招待でやり直せる
    opt = await bob.call('/api/register/options', { method: 'POST', body: { token } });
    const ok = await bob.call('/api/register/verify', {
      method: 'POST', body: { token, challengeId: opt.data.challengeId, response: bobKey.register(opt.data.options) },
    });
    assert.equal(ok.status, 200);
  });

  await t.test('ログアウトするとセッションが無効になる', async () => {
    assert.equal((await alice.call('/api/logout', { method: 'POST', body: {} })).status, 200);
    assert.equal((await alice.call('/api/me')).status, 401);
  });

  await t.test('パスキーでログインできる(ユーザー名なし・カウンター更新)', async () => {
    for (let i = 0; i < 2; i++) {
      const opt = await alice.call('/api/login/options', { method: 'POST', body: {} });
      assert.equal(opt.status, 200);
      assert.equal(opt.data.options.allowCredentials, undefined);
      const res = await alice.call('/api/login/verify', {
        method: 'POST', body: { challengeId: opt.data.challengeId, response: aliceKey.authenticate(opt.data.options) },
      });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal((await alice.call('/api/me')).data.email, aliceMail);
      await alice.call('/api/logout', { method: 'POST', body: {} });
    }
  });

  await t.test('署名改ざん・オリジン不一致・チャレンジ再利用はログイン失敗', async () => {
    const c = new Client();
    let opt = await c.call('/api/login/options', { method: 'POST', body: {} });
    assert.equal((await c.call('/api/login/verify', {
      method: 'POST', body: { challengeId: opt.data.challengeId, response: aliceKey.authenticate(opt.data.options, { tamper: true }) },
    })).status, 401);

    opt = await c.call('/api/login/options', { method: 'POST', body: {} });
    assert.equal((await c.call('/api/login/verify', {
      method: 'POST', body: { challengeId: opt.data.challengeId, response: aliceKey.authenticate(opt.data.options, { origin: 'https://evil.example' }) },
    })).status, 401);

    opt = await c.call('/api/login/options', { method: 'POST', body: {} });
    const good = aliceKey.authenticate(opt.data.options);
    assert.equal((await c.call('/api/login/verify', { method: 'POST', body: { challengeId: opt.data.challengeId, response: good } })).status, 200);
    await c.call('/api/logout', { method: 'POST', body: {} });
    // 同じチャレンジ・同じレスポンスの再送(リプレイ)
    assert.equal((await c.call('/api/login/verify', { method: 'POST', body: { challengeId: opt.data.challengeId, response: good } })).status, 401);
    assert.equal((await c.call('/api/me')).status, 401);
  });

  await t.test('未登録のパスキーではログインできない', async () => {
    const c = new Client();
    const stranger = new FakeAuthenticator();
    const opt = await c.call('/api/login/options', { method: 'POST', body: {} });
    assert.equal((await c.call('/api/login/verify', {
      method: 'POST', body: { challengeId: opt.data.challengeId, response: stranger.authenticate(opt.data.options) },
    })).status, 401);
  });

  await t.test('パスキーの追加・名前変更・削除(最後の1つは削除不可)', async () => {
    const opt0 = await alice.call('/api/login/options', { method: 'POST', body: {} });
    await alice.call('/api/login/verify', {
      method: 'POST', body: { challengeId: opt0.data.challengeId, response: aliceKey.authenticate(opt0.data.options) },
    });
    const second = new FakeAuthenticator();
    // target: 'phone' のときだけ QR コード(ハイブリッド)向けの指定が付く
    const phoneOpt = await alice.call('/api/passkeys/options', { method: 'POST', body: { target: 'phone' } });
    assert.equal(phoneOpt.status, 200);
    assert.deepEqual(phoneOpt.data.options.hints, ['hybrid']);
    assert.equal(phoneOpt.data.options.authenticatorSelection.authenticatorAttachment, 'cross-platform');
    assert.equal(phoneOpt.data.options.authenticatorSelection.userVerification, 'required');
    assert.equal(phoneOpt.data.options.authenticatorSelection.residentKey, 'required');
    const opt = await alice.call('/api/passkeys/options', { method: 'POST', body: {} });
    assert.equal(opt.status, 200);
    assert.deepEqual(opt.data.options.hints, []);
    assert.equal(opt.data.options.authenticatorSelection.authenticatorAttachment, undefined);
    // すでに登録済みの認証器は excludeCredentials に入る
    assert.equal(opt.data.options.excludeCredentials.length, 1);
    const add = await alice.call('/api/passkeys/verify', {
      method: 'POST', body: { challengeId: opt.data.challengeId, response: second.register(opt.data.options) },
    });
    assert.equal(add.status, 200, JSON.stringify(add.data));

    let list = (await alice.call('/api/passkeys')).data.passkeys;
    assert.equal(list.length, 2);
    // 初期名は「{RP_NAME}パスキー YYYY-MM-DD」
    assert.match(list[0].name, /^auth-demoパスキー \d{4}-\d{2}-\d{2}$/);
    const target =list.find((p: any) => p.id === b64u(second.credId));
    assert.equal((await alice.call(`/api/passkeys/${target.id}`, { method: 'PATCH', body: { name: 'テスト端末' } })).status, 200);
    assert.equal((await alice.call(`/api/passkeys/${target.id}`, { method: 'DELETE' })).status, 200);

    list = (await alice.call('/api/passkeys')).data.passkeys;
    assert.equal(list.length, 1);
    assert.equal((await alice.call(`/api/passkeys/${list[0].id}`, { method: 'DELETE' })).status, 409);
    // 他人のパスキーは操作できない(そもそも存在しない扱い)
    assert.equal((await alice.call('/api/passkeys/does-not-exist', { method: 'PATCH', body: { name: 'x' } })).status, 404);
  });

  await t.test('CSRF: Origin が自サイトでない/無い POST は拒否される', async () => {
    assert.equal((await alice.call('/api/logout', { method: 'POST', body: {}, origin: 'https://evil.example' })).status, 403);
    assert.equal((await alice.call('/api/logout', { method: 'POST', body: {}, origin: null })).status, 403);
    assert.equal((await alice.call('/api/me')).status, 200);
  });

  await t.test('利用停止にするとセッションが破棄されログインもできない', async () => {
    assert.equal((await admin.admin('/api/admin/members/disable', 'POST', { email: aliceMail })).status, 200);
    assert.equal((await alice.call('/api/me')).status, 401);
    const opt = await alice.call('/api/login/options', { method: 'POST', body: {} });
    assert.equal((await alice.call('/api/login/verify', {
      method: 'POST', body: { challengeId: opt.data.challengeId, response: aliceKey.authenticate(opt.data.options) },
    })).status, 401);
    // 停止中は招待も発行できない
    assert.equal((await admin.admin('/api/admin/invites', 'POST', { email: aliceMail })).status, 404);
    // 再開すると使える
    assert.equal((await admin.admin('/api/admin/members/enable', 'POST', { email: aliceMail })).status, 200);
    const opt2 = await alice.call('/api/login/options', { method: 'POST', body: {} });
    assert.equal((await alice.call('/api/login/verify', {
      method: 'POST', body: { challengeId: opt2.data.challengeId, response: aliceKey.authenticate(opt2.data.options) },
    })).status, 200);
  });

  await t.test('一覧: パスキー登録数が見える', async () => {
    const { members } = (await admin.admin('/api/admin/members')).data;
    assert.equal(members.find((m: any) => m.email === aliceMail).passkeys, 1);
    assert.equal(members.find((m: any) => m.email === bobMail).passkeys, 1);
  });
});
