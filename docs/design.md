# auth-demo 設計書

| 項目 | 内容 |
|---|---|
| 関連文書 | [仕様書](specification.md) / [README](../README.md) |

## 1. 全体構成

```
ブラウザ ──HTTPS──▶ Cloudflare (Custom Domain: auth-demo.ikaken.com)
                      │
                      ├─ /api/*  ─▶ Worker (src/index.ts, Hono) ─▶ D1 (SQLite)
                      └─ その他  ─▶ Workers Assets (public/ の静的ファイル)

管理者 ── scripts/admin.mjs ── Bearer ADMIN_TOKEN ──▶ /api/admin/*
```

- `wrangler.jsonc` の `assets.run_worker_first: ["/api/*"]` により、`/api/*` だけ Worker を通し、それ以外は静的ファイルを直接配信する。
- 静的ファイルへのセキュリティヘッダーは `public/_headers` で付与する。

## 2. 技術スタック

| 層 | 採用 | 理由 |
|---|---|---|
| ランタイム | Cloudflare Workers | エッジで動作、静的配信と API を一体で運用 |
| Web フレームワーク | Hono | 軽量。Node/Bun/Deno へ移植しやすい |
| WebAuthn | @simplewebauthn/server・browser | 検証ロジックを自前実装しない |
| DB | Cloudflare D1 (SQLite) | Workers とのバインディングが簡単 |
| フロント | 素の HTML + JS(ビルドなし) | 依存を減らし、CSP を `script-src 'self'` に絞れる |
| 言語 | TypeScript(Worker)/ ESM JS(フロント・CLI) | |

## 3. モジュール構成

| ファイル | 責務 |
|---|---|
| `src/index.ts` | ルーティング、ミドルウェア(CSRF・no-store)、セッション、WebAuthn 処理、管理 API |
| `src/db.ts` | `Db` インターフェースと `D1Db` 実装。SQL はすべてここに集約 |
| `src/crypto.ts` | 乱数トークン生成、SHA-256、定数時間比較(Web Crypto) |
| `src/types.ts` | `Env` と行の型 |
| `public/common.js` | `api()` ラッパー、メッセージ表示、SimpleWebAuthn ブラウザ版の読み込み |
| `public/nav.js` | ログイン後の画面共通ヘッダー。`/api/me` でログイン確認し、未ログインならログイン画面へ戻す。メニュー・ログイン状態・ログアウトを描画(DOM 生成のみ。インラインスクリプトなし) |
| `public/login.js` / `register.js` / `account.js` / `dashboard.js` | 各画面のロジック(`dashboard.html` はダミーのダッシュボード。パスキー数のみ `/api/passkeys` の実データ) |
| `scripts/admin.mjs` | 管理 CLI(管理 API の薄いクライアント) |
| `scripts/copy-vendor.mjs` | SimpleWebAuthn ブラウザ版を `public/vendor/` へコピー(`postinstall`) |

### 設計方針
- **DB 抽象化**: `index.ts` は `Db` インターフェースにのみ依存し、`c.var.db` 経由で使う。別 DB へ移す場合は `D1Db` を差し替える。
- **Cloudflare 依存点の局所化**: クライアント IP 取得(`clientIp()`)と静的配信のみ。
- **メール非依存**: 本人性の担保は「招待リンクの秘匿性 + パスキー」で行う。

## 4. データ設計

`migrations/0001_init.sql`。時刻はすべて UNIX 秒(INTEGER)。

```
members 1 ──< credentials
   │ 1
   ├──< invites
   └──< sessions
challenges (member_id は参照のみ・FK なし)
rate_limits (独立)
```

| テーブル | 主キー | 主な列 | 備考 |
|---|---|---|---|
| members | id | email(UNIQUE・小文字), user_handle(UNIQUE), status(`active`/`disabled`), created_at | `user_handle` は WebAuthn の user.id。メールと無関係なランダム 32 バイト |
| credentials | id(credential ID) | member_id, public_key, counter, transports(JSON), device_type, backed_up, name, created_at, last_used_at | 公開鍵のみ保存。1 メンバー複数可 |
| invites | token_hash | member_id, expires_at, used_at, created_at | トークン本体は保存しない。メンバーごとに実質 1 件 |
| challenges | id | challenge, purpose(`register`/`add`/`login`), member_id, expires_at | 1 回限り・短命 |
| sessions | id_hash | member_id, expires_at, created_at | ID 本体は保存しない |
| rate_limits | key | window_start, count | `名前:IP` がキー |

- `members` 削除時は `credentials` / `invites` / `sessions` が `ON DELETE CASCADE`。
- インデックス: `credentials.member_id`、`invites.member_id`、`sessions.member_id`。

## 5. 主要シーケンス

### 5.1 招待経由の初回登録

```
管理者: POST /api/admin/invites {email}
  └ 256bit トークン生成 → SHA-256 を invites に保存(replaceInvite: 旧招待を削除して挿入)
  └ URL = ORIGIN/register.html#token=…(フラグメント)を返す

メンバー: リンクを開く
  register.js: token を読み取り → history で URL から消す
  POST /api/register/options {token}
    └ memberForInvite: 未使用・期限内・メンバー active を確認
    └ generateRegistrationOptions (residentKey/userVerification = required, excludeCredentials)
    └ challenge を保存(5 分)→ {challengeId, options}
  navigator.credentials.create()(端末の本人確認)
  POST /api/register/verify {token, challengeId, response}
    1. consumeInvite: UPDATE … WHERE used_at IS NULL(原子的に消費。同時登録は 1 件のみ成功)
    2. takeChallenge: DELETE … RETURNING(1 回限り)。purpose・member・期限を確認
    3. verifyRegistrationResponse(origin / rpID / UV 必須)
    4. 失敗 → restoreInvite で招待を未使用に戻し 400
    5. 成功 → credentials 保存 → セッション開始(Cookie 発行)
```

### 5.2 ログイン

```
(ログイン画面を開いたとき GET /api/me が 200 ならダッシュボードへ。401 なら画面を表示して待つ)
「パスキーでログイン」ボタン押下で:
POST /api/login/options → generateAuthenticationOptions(allowCredentials なし, UV 必須)
  └ 約 5% の確率で purge()(期限切れ行の掃除)
navigator.credentials.get()
POST /api/login/verify {challengeId, response}
  1. takeChallenge(purpose=login・期限)
  2. response.id から credential を引き、所有メンバーが active か確認
  3. verifyAuthenticationResponse(保存済み公開鍵・counter で署名検証)
  4. touchCredential(counter, last_used_at 更新)→ セッション開始
  ※ どの段階の失敗も 401 login_failed(理由は返さない)
```

### 5.3 パスキー追加・削除
- 追加: ログイン済みで `options`(purpose=`add`)→ `verify`。登録と同じ検証関数 `verifyAndStoreCredential` を共用する。
- スマホ追加(QR): `options` に `target: 'phone'` を渡すと、SimpleWebAuthn の `preferredAuthenticatorType: 'remoteDevice'` により `hints: ['hybrid']` と `authenticatorAttachment: 'cross-platform'` が付き、ブラウザが QR コードの画面を直接開く。`residentKey` / `userVerification` の必須指定は変えない。検証側(`verify`)は通常の追加と同じ。
- 削除: `deleteCredential` は「自分のパスキーで、かつ残りが 2 つ以上のときのみ」削除する単一 SQL。条件を満たさなければ 409。
- 改名: `member_id` 条件付き UPDATE で他人のパスキーは触れない。

### 5.4 利用停止
`disable` でステータス更新後、`deleteSessionsOfMember` で全セッションを破棄。さらに `requireSession` が毎回 `status === 'active'` を確認するため、取りこぼしても通らない。

## 6. セキュリティ設計

| 脅威 | 対策 |
|---|---|
| DB 漏洩 | 公開鍵のみ保存。招待・セッションは SHA-256 のみ。秘密鍵は端末から出ない |
| 招待リンク漏洩(ログ・Referer) | URL フラグメントに格納(サーバーに送られない)+ 読み取り後にアドレスバーから消去 + `Referrer-Policy: no-referrer` |
| 招待の使い回し・競合 | 原子的 `consumeInvite`、有効期限、再発行で旧招待を削除 |
| チャレンジのリプレイ | `DELETE … RETURNING` で取得と同時に削除、purpose・member 照合、5 分失効 |
| 偽サイトでの認証 | `expectedOrigin` / `expectedRPID` の検証、パスキー自体のドメイン紐づけ |
| 端末盗難 | `userVerification: required`(生体認証/PIN) |
| CSRF | 変更系 API の Origin 厳格一致 + SameSite=Lax |
| XSS | CSP `script-src 'self'`(インラインなし)。DOM 出力は textContent 前提 |
| クリックジャッキング | `frame-ancestors 'none'` |
| セッション窃取 | HttpOnly / Secure / `__Host-` 接頭辞 |
| メンバー列挙 | ログイン失敗は汎用応答。ログインはユーザー名を取らない |
| ブルートフォース / 濫用 | IP 単位レート制限、管理 API は 120 回/10 分 |
| 管理トークン推測 | 定数時間比較、レート制限、secret として保管 |
| カウンター巻き戻し | 署名カウンターを更新・検証(同期型パスキーは 0 固定のことがある) |

## 7. エラーハンドリング方針
- API は `{ "error": "<code>" }` の JSON と適切な HTTP ステータスを返す。
- 検証系の内部例外は握りつぶして失敗として扱い、詳細を返さない。
- 想定外例外は `console.error` に出力し、利用者には `internal_error` のみ返す。
- レート制限超過は 429。画面側は「しばらくしてからお試しください」を表示。

## 8. デプロイ・環境設計

| 環境 | RP_ID / ORIGIN | 設定元 |
|---|---|---|
| ローカル | `localhost` / `http://localhost:8787` | `.dev.vars`(git 管理外) |
| 本番 | `auth-demo.ikaken.com` / `https://auth-demo.ikaken.com` | `wrangler.jsonc` の `vars` + secret |

- ローカルは `npm run dev`(`--local-upstream localhost:8787`)。`routes` があると `wrangler dev` が Origin を書き換え、CSRF 検証が通らなくなるための回避。
- デプロイ手順: `d1 create` → `wrangler.jsonc` の `database_id` 更新 → `db:migrate:remote` → `secret put ADMIN_TOKEN` → `deploy`。Custom Domain と DNS レコードは自動作成される。
- **現状**: `wrangler.jsonc` の `database_id` はプレースホルダー(`REPLACE_WITH_YOUR_D1_DATABASE_ID`)のままで、本番 D1 は未作成。

## 9. テスト設計
`test/e2e.test.ts`(`node --test`)。開発サーバーを起動し、ES256 のソフトウェア認証器で次を検証する。

- 招待 → 登録 → ログイン → パスキー追加・削除 → 利用停止の通し動作
- 拒否されること: 署名改ざん、オリジン不一致、チャレンジのリプレイ、Origin のない状態変更(CSRF)
- 型検査: `npm run typecheck`
- 対象外: 実機ブラウザ・OS 連携(デプロイ後に手動確認)

## 10. 移植性・拡張
- **別 DB への移行**: `Db` インターフェースを実装(SQL は SQLite 方言)。
- **別ホスティング**: `clientIp()` のヘッダー、静的配信とヘッダー設定を置き換える。Hono と WebAuthn 処理はそのまま動作する。
- **RP ID 変更**: パスキーは引き継げない。招待再発行、または Related Origin Requests を検討。
- **将来拡張の候補**: 管理者認証の強化(Cloudflare Access)、招待メール送信、監査ログ、セッションのスライディング更新、メンバー削除機能。
