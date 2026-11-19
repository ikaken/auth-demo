import { api, show, isCancel, webauthn } from '/common.js';

const msg = document.getElementById('msg');
const btn = document.getElementById('register-btn');
const { startRegistration, browserSupportsWebAuthn } = webauthn();

// 招待トークンは URL のフラグメントから読み、読んだらアドレスバーから消す(履歴・共有に残さない)
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);

if (!browserSupportsWebAuthn()) {
  show(msg, 'このブラウザはパスキーに対応していません。', 'err');
  btn.disabled = true;
} else if (!token) {
  show(msg, '招待リンクが正しくありません。管理者から届いたリンクをもう一度開いてください。', 'err');
  btn.disabled = true;
}

btn.addEventListener('click', async () => {
  show(msg, '');
  btn.disabled = true;
  try {
    const opt = await api('/api/register/options', { method: 'POST', body: { token } });
    if (!opt.ok) {
      show(msg, opt.status === 429
        ? '試行回数が多すぎます。しばらくしてからお試しください。'
        : '招待リンクが無効か、期限切れです。管理者に再発行を依頼してください。', 'err');
      return;
    }
    const response = await startRegistration({ optionsJSON: opt.data.options });
    const res = await api('/api/register/verify', {
      method: 'POST',
      body: { token, challengeId: opt.data.challengeId, response },
    });
    if (!res.ok) {
      show(msg, '登録に失敗しました。もう一度お試しください。', 'err');
      return;
    }
    location.href = '/dashboard';
  } catch (err) {
    if (err && err.name === 'InvalidStateError') {
      show(msg, 'この端末には、すでにこのアカウントのパスキーが登録されています。', 'err');
    } else if (!isCancel(err)) {
      show(msg, 'パスキーの作成に失敗しました。', 'err');
    }
  } finally {
    btn.disabled = false;
  }
});
