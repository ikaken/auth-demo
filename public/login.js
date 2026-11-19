import { api, show, isCancel, webauthn } from '/common.js';

const msg = document.getElementById('msg');
const btn = document.getElementById('login-btn');
const { startAuthentication, browserSupportsWebAuthn } = webauthn();

async function finishLogin(challengeId, response) {
  const r = await api('/api/login/verify', { method: 'POST', body: { challengeId, response } });
  if (!r.ok) {
    show(msg, r.status === 429 ? '試行回数が多すぎます。しばらくしてからお試しください。' : 'ログインできませんでした。招待が済んでいるか確認してください。', 'err');
    return false;
  }
  location.href = '/dashboard';
  return true;
}

// ボタンからのログイン(パスキー選択のダイアログを表示)
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  show(msg, '');
  btn.disabled = true;
  try {
    const r = await api('/api/login/options', { method: 'POST', body: {} });
    if (!r.ok) return show(msg, 'しばらくしてからお試しください。', 'err');
    const response = await startAuthentication({ optionsJSON: r.data.options });
    await finishLogin(r.data.challengeId, response);
  } catch (err) {
    if (!isCancel(err)) show(msg, 'パスキーの認証に失敗しました。', 'err');
  } finally {
    btn.disabled = false;
  }
});

(async () => {
  if (!browserSupportsWebAuthn()) {
    show(msg, 'このブラウザはパスキーに対応していません。', 'err');
    btn.disabled = true;
    return;
  }
  // すでにログイン済みならダッシュボードへ
  const me = await api('/api/me');
  if (me.ok) location.href = '/dashboard';
})();
