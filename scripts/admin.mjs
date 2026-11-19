#!/usr/bin/env node
// 管理用 CLI。許可リストの登録と招待リンクの発行を行う。
//
//   ADMIN_URL=https://auth-demo.ikaken.com ADMIN_TOKEN=xxxx node scripts/admin.mjs <command>
//
// コマンド:
//   members:add <file.csv>   メールアドレス一覧(1行1件。1列目がメール。ヘッダー行可)を許可リストに登録
//   members:list             許可リストとパスキー登録数を表示
//   members:disable <email>  利用停止(セッションも破棄)
//   members:enable <email>   利用再開
//   invite <email>           招待リンクを発行(パスキー紛失時の復旧にも使う。再発行すると前のリンクは無効)
//   invite:pending           パスキー未登録のメンバー全員に招待リンクを発行
import { readFileSync } from 'node:fs';

const base = (process.env.ADMIN_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error('ADMIN_TOKEN を環境変数で指定してください。');
  process.exit(1);
}

async function call(path, method = 'GET', body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case 'members:add': {
    if (!arg) throw new Error('CSV ファイルを指定してください。');
    const emails = readFileSync(arg, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.split(',')[0].trim().replace(/^"|"$/g, ''))
      .filter((v) => v.includes('@'));
    const r = await call('/api/admin/members', 'POST', { emails });
    console.log(`追加 ${r.added.length} 件 / 既存 ${r.existing.length} 件 / 除外 ${r.rejected.length} 件`);
    for (const x of r.rejected) console.log(`  除外: ${x}`);
    break;
  }
  case 'members:list': {
    const { members } = await call('/api/admin/members');
    for (const m of members) console.log(`${m.status.padEnd(8)} パスキー${m.passkeys}件  ${m.email}`);
    console.log(`合計 ${members.length} 人`);
    break;
  }
  case 'members:disable':
  case 'members:enable': {
    if (!arg) throw new Error('メールアドレスを指定してください。');
    await call(`/api/admin/members/${cmd.split(':')[1]}`, 'POST', { email: arg });
    console.log('OK');
    break;
  }
  case 'invite': {
    if (!arg) throw new Error('メールアドレスを指定してください。');
    const r = await call('/api/admin/invites', 'POST', { email: arg });
    console.log(`${r.email}\n${r.url}\n有効期限: ${new Date(r.expiresAt * 1000).toLocaleString('ja-JP')}`);
    break;
  }
  case 'invite:pending': {
    const { members } = await call('/api/admin/members');
    const pending = members.filter((m) => m.status === 'active' && m.passkeys === 0);
    for (const m of pending) {
      const r = await call('/api/admin/invites', 'POST', { email: m.email });
      console.log(`${m.email}\t${r.url}`);
    }
    console.error(`${pending.length} 件発行しました(各メンバーへ個別に送ってください)。`);
    break;
  }
  default:
    console.error('使い方は scripts/admin.mjs の冒頭コメントを参照してください。');
    process.exit(1);
}
