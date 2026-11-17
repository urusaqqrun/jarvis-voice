// 下載版（app/package.sh 打的）的 App 內更新：看 GitHub 上最新的 Release，有新版就下載 JarvisVoice-<版號>-update.zip，
// 確認是同一張開發者憑證簽的、Gatekeeper 認得（公證過），才換掉舊的 .app 並重新打開。選單列小程式帶起這支，一行一個 JSON：
//   node bin/update.mjs check --current 1.0.0
//     → { type: 'update', state: 'available', version, url } 或 { state: 'none' }、{ state: 'error', message }
//   node bin/update.mjs install --url <zip> --app <現在的 .app> --pid <選單列小程式的 pid>
//     → { state: 'progress', done, total } … { state: 'ready' }（收到就結束選單列小程式，換新與重開由背景的小腳本做）
// 只連 GitHub（api.github.com 與 Release 的下載點），不送任何使用資料。JARVIS_UPDATE_URL 可指定別的 Release 網址（測試用）。

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, createWriteStream, existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const RELEASE_URL = process.env.JARVIS_UPDATE_URL || 'https://api.github.com/repos/urusaqqrun/jarvis-voice/releases/latest';

// 版號比大小（1.2.10 > 1.2.9）；前面的 v 不算
export function newer(a, b) {
  const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

// 從 Release 找比現在新的版號與更新檔
export function pickUpdate(release, current) {
  const version = String(release?.tag_name ?? '').replace(/^v/, '');
  if (!version || release.draft || release.prerelease || !newer(version, current)) return null;
  const asset = (release.assets ?? []).find((a) => a.name === `JarvisVoice-${version}-update.zip`);
  return asset ? { version, url: asset.browser_download_url } : null;
}

export async function check(current) {
  const res = await fetch(RELEASE_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'JarvisVoice' } });
  if (res.status === 404) return null; // 還沒有 Release
  if (!res.ok) throw new Error(`看不到最新版本：HTTP ${res.status}`);
  return pickUpdate(await res.json(), current);
}

// 簽章的 Team ID（codesign -dv 印在 stderr，execFileSync 只回 stdout，所以用 spawnSync）
export function teamOf(app) {
  const { stderr } = spawnSync('/usr/bin/codesign', ['-dv', app], { encoding: 'utf8' });
  return `${stderr ?? ''}`.match(/^TeamIdentifier=(.+)$/m)?.[1] ?? '';
}

function bundleId(app) {
  return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
}

// 換得了才下載：.app 還在 .dmg 裡、或沒拖進「應用程式」就打開（macOS 會把它搬到唯讀的地方跑）都換不了，
// 換不了卻照樣結束重開，只會重開成舊版
export function assertReplaceable(app) {
  const stuck = app.startsWith('/Volumes/') || app.includes('/AppTranslocation/');
  try { if (!stuck) accessSync(dirname(app), constants.W_OK); } catch { throw new Error(`沒辦法換掉 ${app}：先把 JarvisVoice 拖進「應用程式」，從那裡打開再更新`); }
  if (stuck) throw new Error('JarvisVoice 還在下載的 .dmg 或原本的位置裡跑：先把它拖進「應用程式」，從那裡打開再更新');
}

// 下載、解開、驗過，回傳新的 .app 路徑（在暫存資料夾裡）
export async function fetchUpdate(url, app, onProgress = () => {}) {
  assertReplaceable(app);
  const res = await fetch(url, { headers: { 'user-agent': 'JarvisVoice' } });
  if (!res.ok || !res.body) throw new Error(`下載新版失敗：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-update-'));
  const zip = join(dir, 'update.zip');
  let done = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => { done += chunk.length; onProgress(done, total); });
  await pipeline(body, createWriteStream(zip));
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, dir]);
  const fresh = join(dir, 'JarvisVoice.app');
  if (!existsSync(fresh)) throw new Error('新版的壓縮檔裡沒有 JarvisVoice.app');
  // 同一個 app、同一張憑證簽的、Gatekeeper 認得（公證過），才換
  if (bundleId(fresh) !== bundleId(app)) throw new Error('新版的 bundle id 跟現在的不一樣，不換');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', fresh], { stdio: 'ignore' });
  const team = teamOf(app);
  if (!team || teamOf(fresh) !== team) throw new Error('新版不是同一個開發者簽的，不換');
  execFileSync('/usr/sbin/spctl', ['-a', '-t', 'execute', fresh], { stdio: 'ignore' });
  return { dir, fresh };
}

// 等選單列小程式結束，舊的搬到暫存（失敗就搬回來），新的放到原位，重新打開；背景跑，選單列小程式結束了也照樣做完
export function swapLater({ pid, app, fresh, dir }) {
  const script = join(dir, 'swap.sh');
  writeFileSync(script, `#!/bin/bash
for i in $(seq 1 100); do kill -0 ${pid} 2>/dev/null || break; sleep 0.1; done
old="${dir}/old.app"
if mv "${app}" "$old"; then
  if mv "${fresh}" "${app}"; then rm -rf "$old"; else mv "$old" "${app}"; fi
fi
open "${app}"
rm -rf "${dir}"
`, { mode: 0o755 });
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : ''; };
  const say = (event) => process.stdout.write(`${JSON.stringify({ type: 'update', ...event })}\n`);
  try {
    if (command === 'check') {
      const found = await check(opt('current'));
      say(found ? { state: 'available', ...found } : { state: 'none' });
    } else if (command === 'install') {
      let shownAt = 0;
      const app = realpathSync(opt('app'));
      const { dir, fresh } = await fetchUpdate(opt('url'), app, (done, total) => {
        if (Date.now() - shownAt < 250 && done !== total) return;
        shownAt = Date.now();
        say({ state: 'progress', done, total });
      });
      swapLater({ pid: Number(opt('pid')), app, fresh, dir });
      say({ state: 'ready' });
    } else {
      say({ state: 'error', message: `不認得的指令：${command}` });
      process.exitCode = 2;
    }
  } catch (err) {
    say({ state: 'error', message: err.message.split('\n')[0] });
    process.exitCode = 1;
  }
}

// 直接執行才跑（從 symlink 叫也算）
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
