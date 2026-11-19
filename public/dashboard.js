import { api } from '/common.js';
import { mountAppBar } from '/nav.js';

(async () => {
  const email = await mountAppBar('dashboard');
  if (!email) return;
  document.getElementById('greeting').textContent = `${email} でログイン中です。`;

  // 登録済みパスキー数だけは実データを表示する
  const r = await api('/api/passkeys');
  if (r.ok) document.getElementById('pk-count').textContent = String(r.data.passkeys.length);
})();
