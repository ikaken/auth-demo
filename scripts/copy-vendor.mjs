// @simplewebauthn/browser の UMD バンドルを public/vendor/ にコピーする(CDN に依存しないため)
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';

const src = 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js';
if (!existsSync(src)) {
  console.warn('[vendor] skip: @simplewebauthn/browser is not installed yet');
  process.exit(0);
}
mkdirSync('public/vendor', { recursive: true });
copyFileSync(src, 'public/vendor/simplewebauthn-browser.js');
console.log('[vendor] copied simplewebauthn-browser.js');
