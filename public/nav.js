// ログイン後の画面で共通のヘッダー(ログイン状態・メニュー・ログアウト)
// 未ログインならログイン画面へ戻す。ログイン中のメールアドレスを返す。
import { api } from '/common.js';

const LINKS = [
  { id: 'dashboard', href: '/dashboard', label: 'ダッシュボード' },
  { id: 'account', href: '/account', label: 'パスキー管理' },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function mountAppBar(active) {
  const me = await api('/api/me');
  if (!me.ok) {
    location.href = '/';
    return null;
  }
  const email = me.data.email;

  const brand = el('a', 'brand', 'auth-demo');
  brand.href = '/dashboard';

  const nav = el('nav', 'menu');
  nav.setAttribute('aria-label', 'メニュー');
  for (const l of LINKS) {
    const a = el('a', '', l.label);
    a.href = l.href;
    if (l.id === active) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }

  const status = el('span', 'status');
  status.append(el('span', 'dot'), document.createTextNode('ログイン中'));
  const who = el('span', 'who', email);
  who.title = email;
  const logout = el('button', 'small', 'ログアウト');
  logout.type = 'button';
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    await api('/api/logout', { method: 'POST', body: {} });
    location.href = '/';
  });
  const user = el('div', 'user');
  user.append(status, who, logout);

  const inner = el('div', 'appbar-in');
  inner.append(brand, nav, user);
  const header = el('header', 'appbar');
  header.append(inner);
  document.body.prepend(header);

  document.querySelector('main')?.removeAttribute('hidden');
  return email;
}
