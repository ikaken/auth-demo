// 共通ヘルパー(CSP のためインラインスクリプトは使わず、すべて外部ファイルにする)
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* 空レスポンス */ }
  return { ok: res.ok, status: res.status, data };
}

export function show(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind}`.trim();
}

/** ブラウザのパスキー操作でユーザーがキャンセルしたときの判定 */
export function isCancel(err) {
  return err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
}

export function webauthn() {
  return window.SimpleWebAuthnBrowser;
}
