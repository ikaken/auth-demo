# auth-demo 仕様書

| 項目 | 内容 |
|---|---|
| 対象 | 招待制パスキー(WebAuthn)認証デモ |
| 本番 URL | https://auth-demo.ikaken.com(RP ID も同じ) |
| 関連文書 | [設計書](design.md) / [README](../README.md) |

## 1. 目的とスコープ

### 1.1 目的
招待されたメンバーだけがログインできる、**パスワードレス・メール送信なし**の認証基盤を、パスキーで実現するデモ。

### 1.2 スコープ内
- 許可リスト(メンバー)の管理
- 招待リンクの発行と、それを使った初回パスキー登録
- パスキーによるログイン / ログアウト
- ログイン後のパスキー管理(追加・名前変更・削除)
- 管理者による利用停止・再開、パスキー紛失時の復旧

### 1.3 スコープ外
- メール送信(招待リンクは管理者が手作業で本人に渡す)
- パスワード、SMS、TOTP などの他の認証要素
- 管理者の多要素認証・権限分離(共有 Bearer トークンのみ)
- メンバーのセルフ登録(許可リストにないメールは一切登録不可)
- メンバーの完全削除(無効化のみ)

## 2. 用語

| 用語 | 意味 |
|---|---|
| メンバー | 許可リストに登録されたメールアドレスを持つ利用者 |
| 許可リスト | `members` テーブル。ここにないメールアドレスは登録・ログインできない |
| 招待リンク | 1回限り・期限付きの登録用 URL。`/register.html#token=…` |
| パスキー | 端末内に保存される WebAuthn の Discoverable Credential |
| RP ID | パスキーの紐づけ先ドメイン。`auth-demo.ikaken.com` |
| 管理者 | `ADMIN_TOKEN` を保持し、管理 CLI / 管理 API を使う人 |

## 3. 利用者と役割

| 役割 | できること |
|---|---|
| 管理者 | 許可リスト登録、一覧、利用停止/再開、招待リンク発行 |
| メンバー(登録済み) | パスキーでログイン、パスキーの追加・改名・削除、ログアウト |
| メンバー(未登録) | 招待リンクからのパスキー初回登録 |
| 第三者 | 何もできない(登録・ログインとも不可) |

## 4. 機能要件

### F1. 許可リスト管理(管理者)
- F1-1 メールアドレスを一括登録できる(1リクエスト最大 500 件)。
- F1-2 メールアドレスは前後の空白除去・小文字化して保存し、形式(`x@y.z`)と長さ(254 文字以下)を検証する。形式不正は「除外」として返す。
- F1-3 登録済みアドレスは「既存」として返し、重複登録しない。
- F1-4 メンバー総数が `MAX_MEMBERS`(既定 50)に達したら、それ以上は「除外(上限)」とする。
- F1-5 一覧で各メンバーのステータスとパスキー数を確認できる。
- F1-6 利用停止すると、そのメンバーの全セッションを即時破棄し、ログイン・招待登録ができなくなる。再開で `active` に戻る。

### F2. 招待
- F2-1 管理者は `active` なメンバーに対して招待リンクを発行できる。
- F2-2 リンクは 1 回限り・有効期間 `INVITE_TTL_HOURS`(既定 48 時間)。
- F2-3 同じメンバーへの再発行で、以前の未使用リンクは無効になる(メンバーごとに有効な招待は常に 1 つ)。
- F2-4 パスキー未登録の `active` メンバー全員分を一括発行できる(`invite:pending`)。
- F2-5 パスキーを紛失したメンバーの復旧は、招待の再発行 → 新端末での登録で行う。

### F3. パスキー初回登録(招待経由)
- F3-1 招待リンクを開くと、トークンを URL フラグメントから読み取り、アドレスバーから消す。
- F3-2 有効な招待を持つ者だけが、そのメンバーのパスキーを登録できる。
- F3-3 登録に成功すると招待は使用済みになり、そのままログイン状態になる。
- F3-4 登録の検証に失敗した場合、招待は未使用に戻る(やり直し可能)。
- F3-5 同じ招待による同時登録は 1 件だけ成功する。
- F3-6 既に登録済みの認証器での二重登録は拒否される(`excludeCredentials`)。

### F4. ログイン / ログアウト
- F4-1 ユーザー名・メール入力なし。パスキー(Discoverable Credential)がメンバーを特定する。
- F4-2 ログインは「パスキーでログイン」ボタンの操作のみ(ボタン押下でパスキー選択のダイアログを表示)。入力欄でのパスキー自動提示(Conditional UI)は使わない。ログイン画面を開いただけではログイン用のチャレンジを作らない。
- F4-3 端末での本人確認(生体認証 / PIN)を必須とする。
- F4-4 失敗理由は区別せず、汎用メッセージのみ返す(メンバーの存在確認に使わせない)。
- F4-5 利用停止中のメンバーはログインできない。
- F4-6 ログイン済みでログイン画面を開くと、アカウント画面へ遷移する。
- F4-7 ログアウトでセッションを破棄し Cookie を削除する。

### F5. パスキー管理(ログイン後)
- F5-1 自分のパスキー一覧(名前、作成日時、最終利用日時、同期型か、バックアップ済みか)を表示する。
- F5-2 パスキーを追加登録できる(再度の本人確認が必要)。
- F5-2a 追加は 2 通り。「パスワード管理で追加する」はブラウザの標準の選択画面、「QRコードで追加する」は QR コード(ハイブリッド転送)の画面を直接開く。後者は PC 向けの画面にのみ表示し、スマホ・タブレットの UA では表示しない。
- F5-3 名前を変更できる(1〜60 文字)。初期名は「{RP_NAME}パスキー YYYY-MM-DD」(例: `auth-demoパスキー 2026-11-19`。日付は UTC)。
- F5-4 パスキーを削除できる。**最後の 1 つは削除できない**。
- F5-5 他人のパスキーは操作できない。

### F6. セッション
- F6-1 有効期間は `SESSION_TTL_DAYS`(既定 7 日)。スライディング更新はしない。
- F6-2 期限切れ・利用停止・ログアウトで無効になる。

## 5. API 仕様

共通事項
- 形式は JSON。全 `/api/*` 応答に `Cache-Control: no-store`。
- 状態変更系(POST/PATCH/DELETE)は、`Origin` ヘッダーが `ORIGIN` と一致しない場合 `403 {"error":"forbidden"}`(管理 API を除く)。
- 想定外の例外は `500 {"error":"internal_error"}`、未定義パスは `404 {"error":"not_found"}`。

### 5.1 公開 API(認証不要)

| メソッド・パス | 用途 | 主な入力 | 成功 | 主な失敗 |
|---|---|---|---|---|
| POST `/api/register/options` | 登録用オプション取得 | `token` | 200 `{challengeId, options}` | 400 `invalid_invite` / 429 |
| POST `/api/register/verify` | 登録検証・保存・ログイン | `token, challengeId, response` | 200 `{ok}` + セッション Cookie | 400 `invalid_request` `invalid_invite` `verification_failed` / 429 |
| POST `/api/login/options` | ログイン用オプション取得 | なし | 200 `{challengeId, options}` | 429 |
| POST `/api/login/verify` | ログイン検証 | `challengeId, response` | 200 `{ok}` + セッション Cookie | 401 `login_failed` / 429 |

### 5.2 ログイン後 API(セッション Cookie 必須、なければ 401 `unauthorized`)

| メソッド・パス | 用途 | 入力 | 成功 | 失敗 |
|---|---|---|---|---|
| GET `/api/me` | 自分の情報 | - | 200 `{email}` | 401 |
| POST `/api/logout` | ログアウト | - | 200 `{ok}` | 401 |
| GET `/api/passkeys` | 一覧 | - | 200 `{passkeys:[{id,name,createdAt,lastUsedAt,synced,backedUp}]}` | 401 |
| POST `/api/passkeys/options` | 追加用オプション | `target`(任意。`phone` で QR コード向け: `hints=[hybrid]`・`authenticatorAttachment=cross-platform`) | 200 `{challengeId, options}` | 401 / 429 |
| POST `/api/passkeys/verify` | 追加の検証・保存 | `challengeId, response` | 200 `{ok}` | 400 `invalid_request` `verification_failed` / 429 |
| PATCH `/api/passkeys/:id` | 改名 | `name` | 200 `{ok}` | 400 `invalid_name` / 404 `not_found` |
| DELETE `/api/passkeys/:id` | 削除 | - | 200 `{ok}` | 409 `cannot_delete`(存在しない・最後の 1 つ) |

### 5.3 管理 API(`Authorization: Bearer <ADMIN_TOKEN>`)

`ADMIN_TOKEN` 未設定なら全て 503 `admin_disabled`、トークン不一致は 401 `unauthorized`。

| メソッド・パス | 用途 | 入力 | 成功 |
|---|---|---|---|
| GET `/api/admin/members` | 一覧 | - | 200 `{members:[{email,status,passkeys,…}]}` |
| POST `/api/admin/members` | 一括登録 | `emails[]`(最大 500) | 200 `{added, existing, rejected}` |
| POST `/api/admin/members/disable` | 利用停止 | `email` | 200 `{ok}` / 404 |
| POST `/api/admin/members/enable` | 利用再開 | `email` | 200 `{ok}` / 404 |
| POST `/api/admin/invites` | 招待発行 | `email` | 200 `{email, url, expiresAt}` / 404(未登録・停止中) |

## 6. 画面仕様

| 画面 | パス | 内容 |
|---|---|---|
| ログイン | `/`(index.html) | 「パスキーでログイン」ボタンのみ。未対応ブラウザには案内を表示してボタンを無効化。ログイン済みならダッシュボードへ |
| 登録 | `/register.html#token=…` | 招待リンクからのパスキー登録。成功後はダッシュボードへ |
| ダッシュボード | `/dashboard`(dashboard.html) | ログイン後のトップ。ダミーのサマリー・お知らせ・アクティビティ(「ダミー」表記)と、実データの登録済みパスキー数。未ログインならログイン画面へ |
| パスキー管理 | `/account`(account.html) | パスキー一覧・追加・改名・削除。未ログインならログイン画面へ |

ログイン後の 2 画面(ダッシュボード・パスキー管理)は共通ヘッダー(`nav.js`)を持つ。ヘッダーには「ログイン中」表示、メールアドレス、メニュー(ダッシュボード / パスキー管理)、ログアウトボタンを表示し、現在の画面をメニューで強調する。`*.html` へのアクセスは拡張子なしの URL へ 307 リダイレクトされる(Workers Assets の仕様)。

エラー文言は利用者向けの汎用表現のみ(例:「ログインできませんでした。招待が済んでいるか確認してください。」)。

## 7. 非機能要件

### 7.1 セキュリティ

| 項目 | 要件 |
|---|---|
| 本人確認 | `userVerification: required`、`residentKey: required` |
| トークン類 | 招待・セッションは 256bit 乱数。DB には SHA-256 のみ保存 |
| Cookie | `HttpOnly; SameSite=Lax; Path=/`、HTTPS では `Secure` + `__Host-session` |
| チャレンジ | 1 回限り(取得と同時に削除)、有効 5 分 |
| CSRF | Origin 検証 + SameSite=Lax |
| ヘッダー | CSP(`default-src 'self'; script-src 'self'` ほか)、`nosniff`、`Referrer-Policy: no-referrer`、`frame-ancestors 'none'`、Permissions-Policy で WebAuthn を自サイトに限定 |
| 管理トークン比較 | 定数時間比較 |
| 秘密情報 | `ADMIN_TOKEN` は Wrangler secret。リポジトリに含めない |

### 7.2 レート制限(IP 単位・固定窓 600 秒)

| 対象 | 上限 |
|---|---|
| 登録 options / verify | 各 20 回 |
| ログイン options | 60 回 |
| ログイン verify | 30 回 |
| パスキー追加 options / verify | 各 20 回 |
| 管理 API | 120 回 |

超過時は 429 `too_many_requests`。

### 7.3 運用・容量
- 許可リスト上限 `MAX_MEMBERS` = 50(既定)。
- 期限切れのチャレンジ・セッション・未使用招待・古いレート制限行は、`/api/login/options` 呼び出し時に約 5% の確率で削除する。
- 無料枠は Cloudflare アカウント全体で共有される(Workers 1 日 10 万リクエスト等)。

### 7.4 互換性
- WebAuthn 対応ブラウザが必要。
- `localhost` では HTTP でも動作(開発用)。

## 8. 設定値

| 変数 | 既定 | 種別 | 意味 |
|---|---|---|---|
| `RP_ID` | `auth-demo.ikaken.com` | var | パスキー紐づけ先。**運用開始後は変更不可** |
| `RP_NAME` | `auth-demo` | var | 認証器に表示される名前 |
| `ORIGIN` | `https://auth-demo.ikaken.com` | var | 期待するオリジン |
| `MAX_MEMBERS` | 50 | var | 許可リスト上限 |
| `INVITE_TTL_HOURS` | 48 | var | 招待の有効時間 |
| `SESSION_TTL_DAYS` | 7 | var | セッションの有効日数 |
| `ADMIN_TOKEN` | なし | secret | 管理 API の Bearer トークン |

## 9. 既知の制限

- 招待リンクの配布は管理者の手作業。リンクを知る者は誰でもそのアカウントに登録できるため、個別経路で渡す必要がある。
- 管理 API は共有トークンの簡易認証。複数管理者の本番運用では Cloudflare Access 等で保護する。
- レート制限は IP 単位の固定窓で、厳密な不正対策には WAF 等の併用が必要。
- 実機(iOS/Android/各ブラウザ)でのパスキー動作は自動テストの対象外。
- RP ID を変更すると登録済みパスキーは使えなくなる(招待の再発行で再登録)。
