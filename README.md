# auth-demo

招待されたメンバーだけが使える、**パスキー(WebAuthn)認証**のデモアプリです。
パスワードもメール送信も使いません。

- 本番 URL: https://auth-demo.ikaken.com (RP ID も同じ値)
- 技術構成: TypeScript / [Hono](https://hono.dev) / [SimpleWebAuthn](https://simplewebauthn.dev) / Cloudflare Workers + D1
- フロントは素の HTML + JS(ビルド不要)。ログインは「パスキーでログイン」ボタンのみ(入力欄でのパスキー自動入力 = Conditional UI は使わない)

## 仕組み

```
管理者                         サーバー                         メンバー
  │ members:add (許可リスト)      │                                 │
  │──────────────────────────────▶│                                 │
  │ invite alice@…  (招待リンク)   │                                 │
  │──────────────────────────────▶│                                 │
  │◀──────── https://…/register.html#token=… ───                    │
  │──────────── (チャットなど別経路で本人に渡す) ──────────────────▶│
  │                               │◀── 招待リンクを開いてパスキー登録 ─│
  │                               │     (1回限り・48時間で失効)       │
  │                               │◀── 以降はパスキーでログイン ──────│
```

- **利用できるのは許可リスト(`members`)に載っているメールアドレスだけ**です。
- 許可リストのメールアドレスを知っているだけでは登録できません。**管理者が発行した招待リンク**(1回限り・期限付き)を持つ人だけが、そのメールアドレスのアカウントにパスキーを登録できます(メール送信が不要で、なりすまし登録も防げます)。
- ログインはユーザー名なし。パスキーがメンバーを特定します。
- ログイン後は共通ヘッダー(ログイン状態・メニュー・ログアウト)付きのダッシュボード(ダミー)と、パスキー管理画面を行き来できます。
- パスキーは1人が複数登録できます(パスキー管理画面で追加・名前変更・削除。最後の1つは削除不可)。追加は「パスワード管理で追加する」(ブラウザ標準)と「QRコードで追加する」(スマホ経由。PC の Bluetooth が必要)の2通りです。
- **パスキーを紛失した場合**: 管理者が `invite <email>` で招待リンクを再発行し、新しい端末で登録し直します。

## セキュリティ設計の要点

| 項目 | 内容 |
|---|---|
| 本人確認 | 端末での生体認証/PIN を必須(`userVerification: required`)。パスキーが唯一の要素のため |
| 招待トークン | 256bit 乱数。DB には SHA-256 のみ保存。URL のフラグメント(`#token=`)に入れるのでサーバーログ・Referer に残らない。登録画面で読み取り後にアドレスバーから消す |
| セッション | 256bit 乱数。DB には SHA-256 のみ保存。Cookie は `HttpOnly; Secure; SameSite=Lax`(本番は `__Host-` 接頭辞) |
| CSRF | 状態を変える API は `Origin` が自サイトのときのみ受け付ける + SameSite=Lax |
| チャレンジ | 1回限り・5分で失効。取得と同時に削除(リプレイ防止) |
| レート制限 | 登録・ログイン・管理 API に IP 単位の固定窓制限 |
| 公開鍵のみ保存 | 秘密鍵は端末から出ない。DB が漏れてもログインはできない |
| ヘッダー | CSP(`script-src 'self'`)、`X-Content-Type-Options`、`Referrer-Policy: no-referrer` など(`public/_headers`) |
| ログイン失敗 | 原因を区別しない汎用メッセージ(メンバーの存在確認に使わせない) |
| 利用停止 | `members:disable` で即時にセッション破棄・ログイン不可 |

## ディレクトリ構成

```
auth-demo/
├─ src/
│  ├─ index.ts        # API 本体 (Hono)。登録・ログイン・パスキー管理・管理API
│  ├─ db.ts           # DB インターフェース + D1 実装
│  ├─ crypto.ts       # 乱数・SHA-256 (Web Crypto)
│  └─ types.ts
├─ public/            # 静的ファイル (index/register/dashboard/account.html、共通ヘッダー nav.js、JS/CSS)
├─ migrations/        # D1 スキーマ
├─ scripts/
│  ├─ admin.mjs       # 管理 CLI (許可リスト登録・招待発行)
│  └─ copy-vendor.mjs # SimpleWebAuthn ブラウザ版を public/vendor/ にコピー
├─ test/e2e.test.ts   # ソフトウェア認証器による結合テスト
├─ docs/              # 仕様書・設計書
└─ wrangler.jsonc     # Cloudflare 設定
```

詳細は [仕様書](docs/specification.md) / [設計書](docs/design.md) を参照してください。

## ローカル開発

```bash
npm install
cp .dev.vars.example .dev.vars          # RP_ID=localhost / ORIGIN=http://localhost:8787
npm run db:migrate:local
npm run dev                             # http://localhost:8787
```

別ターミナルで許可リストと招待を作ります。

```bash
export ADMIN_URL=http://localhost:8787 ADMIN_TOKEN=dev-admin-token-change-me
# members.csv を作る: 1行に1メールアドレス(ヘッダー行可。git 管理外)
echo you@example.com > members.csv
node scripts/admin.mjs members:add members.csv
node scripts/admin.mjs invite you@example.com   # 表示された URL をブラウザで開く
```

ブラウザで `http://localhost:8787/register.html#token=…` を開いてパスキーを登録します。
`localhost` は HTTPS 無しでもパスキーが使えます。

> **メモ**: `npm run dev` は `--local-upstream localhost:8787` 付きです。`wrangler.jsonc` に `routes`(本番ドメイン)があると、
> `wrangler dev` が `Origin` ヘッダーを本番ドメインに書き換えてしまい、Origin 検証が通らなくなるためです。

### テスト

開発サーバーを起動した状態で実行します。ソフトウェア認証器(ES256)で、招待 → 登録 → ログイン →
パスキー追加/削除 → 利用停止、署名改ざん・オリジン不一致・リプレイ・CSRF が拒否されることまで確認します。

```bash
ADMIN_TOKEN=dev-admin-token-change-me npm test
npm run typecheck
```

## Cloudflare へのデプロイ

`ikaken.com` が同じ Cloudflare アカウントのゾーンになっていることが前提です。

```bash
npx wrangler login

# 1. D1 を作成し、表示された database_id を wrangler.jsonc に貼る
npx wrangler d1 create auth-demo

# 2. 本番 DB にスキーマを適用
npm run db:migrate:remote

# 3. 管理 API のトークン (secret) を登録
openssl rand -base64 32                 # 生成した値を控えておく
npx wrangler secret put ADMIN_TOKEN

# 4. デプロイ (Custom Domain が自動で作成され、DNS レコードも自動追加される)
npm run deploy
```

- `auth-demo.ikaken.com` に同名の DNS レコードが既にあると Custom Domain を作れません。その場合は先に削除してください。
- 管理 CLI の接続先を本番にします。

```bash
export ADMIN_URL=https://auth-demo.ikaken.com ADMIN_TOKEN='<控えたトークン>'
node scripts/admin.mjs members:add members.csv
node scripts/admin.mjs invite:pending           # パスキー未登録の全員分の招待リンクを発行
node scripts/admin.mjs members:list
```

発行した招待リンクは、**メンバー本人に個別の経路(チャット・メール等)で渡してください**。リンクを知っている人は誰でもそのアカウントに登録できます。

### 設定値 (`wrangler.jsonc` の `vars`)

| 変数 | 既定 | 意味 |
|---|---|---|
| `RP_ID` | `auth-demo.ikaken.com` | パスキーの紐づけ先。**一度運用したら変更不可**(変更すると登録済みパスキーが使えなくなる) |
| `ORIGIN` | `https://auth-demo.ikaken.com` | 期待するオリジン(スキーム + ホスト) |
| `MAX_MEMBERS` | 50 | 許可リストの上限(公開デモでの DB 肥大化対策) |
| `INVITE_TTL_HOURS` | 48 | 招待リンクの有効時間 |
| `SESSION_TTL_DAYS` | 7 | ログインの有効日数 |

## 他のアプリとの共用・本番移行について

- **RP ID はサブドメイン単位で分離**してあります(`auth-demo.ikaken.com`)。同じドメインの他アプリとはパスキーも Cookie も共有されません。
- Cloudflare の無料枠は**アカウント全体で共有**です(Workers: 1日10万リクエスト、D1: 合計 5GB・1日の読み書き行数に上限)。D1 のデータベースはアプリごとに分けてください。
- **Cloudflare 以外へ移す場合**に書き換えるのは次の部分だけです。
  - `src/db.ts` … `Db` インターフェースを別 DB(Postgres など)向けに実装する(SQL は SQLite 方言)
  - `src/index.ts` の `clientIp()` … クライアント IP を取るヘッダー
  - 静的ファイル配信(`public/` と `_headers` は Workers の assets 機能) … Node 等では `serveStatic` とヘッダー設定に置き換える
  - Hono 本体と WebAuthn の処理は、Node / Bun / Deno でそのまま動きます。
- **DNS 事業者が変わっても、ドメイン(RP ID)が同じなら登録済みパスキーはそのまま使えます**。RP ID が変わる場合は、パスキーの引き継ぎはできません。管理者が `invite` で招待を再発行して登録し直すか、[Related Origin Requests](https://developer.chrome.com/blog/io26-web-identity) で旧ドメインと連携する方法があります。

## 既知の制限(デモとしての割り切り)

- メール送信は行いません。招待リンクの配布は管理者の手作業です。
- 管理 API は共有の Bearer トークンによる簡易認証です。本番で管理者が複数いる場合は、Cloudflare Access などで保護してください。
- レート制限は IP 単位の固定窓です。厳密な不正対策が必要な場合は、WAF やレート制限サービスを併用してください。
- 実機(iOS/Android/各ブラウザ)でのパスキー動作は、自動テストの対象外です。デプロイ後に実際の端末で確認してください。

## ライセンス

[MIT License](LICENSE)
