import { api, show, isCancel, webauthn } from '/common.js';
import { mountAppBar } from '/nav.js';

const msg = document.getElementById('msg');
const list = document.getElementById('list');
const { startRegistration } = webauthn();

const fmt = (sec) => (sec ? new Date(sec * 1000).toLocaleString('ja-JP') : '未使用');

async function render() {
  const r = await api('/api/passkeys');
  if (!r.ok) return;
  list.replaceChildren();
  const items = r.data.passkeys;
  for (const pk of items) {
    const li = document.createElement('li');

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'pk-name';
    name.textContent = pk.name;
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `作成: ${fmt(pk.createdAt)} / 最終利用: ${fmt(pk.lastUsedAt)}${pk.synced ? ' / 同期あり' : ''}`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'pk-actions';
    const rename = document.createElement('button');
    rename.className = 'small';
    rename.textContent = '名前変更';
    rename.addEventListener('click', () => renamePasskey(pk));
    const del = document.createElement('button');
    del.className = 'small danger';
    del.textContent = '削除';
    del.disabled = items.length <= 1;
    del.title = items.length <= 1 ? '最後の1つは削除できません' : '';
    del.addEventListener('click', () => deletePasskey(pk));
    actions.append(rename, del);

    li.append(info, actions);
    list.append(li);
  }
}

async function renamePasskey(pk) {
  const name = prompt('パスキーの名前(例: 会社のノートPC、iPhone)', pk.name);
  if (!name || !name.trim()) return;
  const r = await api(`/api/passkeys/${encodeURIComponent(pk.id)}`, { method: 'PATCH', body: { name: name.trim() } });
  show(msg, r.ok ? '名前を変更しました。' : '名前を変更できませんでした。', r.ok ? 'ok' : 'err');
  render();
}

async function deletePasskey(pk) {
  if (!confirm(`「${pk.name}」を削除します。この端末からはこのパスキーでログインできなくなります。`)) return;
  const r = await api(`/api/passkeys/${encodeURIComponent(pk.id)}`, { method: 'DELETE' });
  show(msg, r.ok ? '削除しました。端末側のパスキーも必要に応じて削除してください。' : '削除できませんでした。', r.ok ? 'ok' : 'err');
  render();
}

// target: 'phone' ならスマホ・タブレット向け(QR コード)。省略するとブラウザの標準の選択画面
async function addPasskey(target) {
  show(msg, '');
  const buttons = document.querySelectorAll('#add-btn, #add-phone-btn');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const opt = await api('/api/passkeys/options', { method: 'POST', body: target ? { target } : {} });
    if (!opt.ok) return show(msg, 'しばらくしてからお試しください。', 'err');
    const response = await startRegistration({ optionsJSON: opt.data.options });
    const res = await api('/api/passkeys/verify', {
      method: 'POST',
      body: { challengeId: opt.data.challengeId, response },
    });
    show(msg, res.ok ? 'パスキーを追加しました。分かりやすい名前に変更しておくと便利です。' : '追加に失敗しました。', res.ok ? 'ok' : 'err');
    render();
  } catch (err) {
    if (err && err.name === 'InvalidStateError') {
      show(msg, target === 'phone'
        ? 'そのスマホ・タブレットには、すでにこのアカウントのパスキーが登録されています(同じアカウントで同期されている場合を含みます)。'
        : 'この端末には、すでにこのアカウントのパスキーが登録されています。', 'err');
    } else if (!isCancel(err)) {
      show(msg, 'パスキーの作成に失敗しました。', 'err');
    }
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

document.getElementById('add-btn').addEventListener('click', () => addPasskey());
document.getElementById('add-phone-btn').addEventListener('click', () => addPasskey('phone'));

// スマホ・タブレット自身で開いているときは、その端末に作る(上のボタン)のが自然なので、QR のボタンは出さない
if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  document.getElementById('phone-add').hidden = false;
}

(async () => {
  // ヘッダー(ログイン状態・メニュー・ログアウト)を表示。未ログインならログイン画面へ戻る
  if (!(await mountAppBar('account'))) return;
  render();
})();
