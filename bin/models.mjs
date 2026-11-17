// 本機要用的模型：SenseVoice-Small（本機辨識、講話中的即時預覽）與 CAM++（只聽我的聲音）。模型網址只寫在這裡，
// install.sh 與 .app 第一次打開的設定畫面都叫這支。缺的才下載，下載到 <狀態資料夾>/models，已經有的不動。
//   node bin/models.mjs                 兩個都檢查，缺的下載（終端機看得到進度）
//   node bin/models.mjs local|speaker   只管其中一個
//   node bin/models.mjs --json          進度一行一個 JSON（選單列小程式讀）：
//     { type: 'models', state: 'progress', model, done, total } … { state: 'done' } 或 { state: 'error', model, message }

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, STATE_DIR } from './config.mjs';
import { VOICEPRINT_MODEL } from './voiceprint.mjs';

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export const MODELS = {
  local: {
    name: 'SenseVoice-Small',
    url: `${RELEASES}/asr-models/${DEFAULT_MODEL}.tar.bz2`,
    path: join(STATE_DIR, 'models', DEFAULT_MODEL, 'model.int8.onnx'),
    unpack: join(STATE_DIR, 'models'), // 壓縮檔裡是 <DEFAULT_MODEL>/ 整個資料夾
  },
  speaker: {
    name: 'CAM++',
    url: `${RELEASES}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`,
    path: join(STATE_DIR, 'models', 'speaker', VOICEPRINT_MODEL),
  },
};

export const missingModels = (names = Object.keys(MODELS)) => names.filter((name) => !existsSync(MODELS[name].path));

// 下載一個模型：先寫到暫存資料夾，整個好了才搬過去，中途斷掉不會留下半個模型。onProgress(done, total)
export async function download(name, onProgress = () => {}) {
  const model = MODELS[name];
  const res = await fetch(model.url);
  if (!res.ok || !res.body) throw new Error(`下載 ${model.name} 失敗：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  mkdirSync(join(STATE_DIR, 'models'), { recursive: true });
  const tmp = mkdtempSync(join(STATE_DIR, 'models', '.download-'));
  try {
    const file = join(tmp, model.url.split('/').pop());
    let done = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => { done += chunk.length; onProgress(done, total); });
    await pipeline(body, createWriteStream(file));
    if (model.unpack) {
      execFileSync('/usr/bin/tar', ['-xjf', file, '-C', tmp]);
      const unpacked = join(tmp, DEFAULT_MODEL);
      if (!existsSync(join(unpacked, 'model.int8.onnx'))) throw new Error(`${model.name} 解開後找不到 model.int8.onnx`);
      rmSync(join(model.unpack, DEFAULT_MODEL), { recursive: true, force: true });
      renameSync(unpacked, join(model.unpack, DEFAULT_MODEL));
    } else {
      mkdirSync(dirname(model.path), { recursive: true });
      renameSync(file, model.path);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const asked = args.filter((a) => MODELS[a]);
  const names = asked.length ? asked : Object.keys(MODELS);
  const todo = missingModels(names);
  const say = (event) => process.stdout.write(`${JSON.stringify({ type: 'models', ...event })}\n`);
  if (!json) for (const name of names) if (!todo.includes(name)) process.stdout.write(`  ${MODELS[name].name} 已經在了\n`);
  for (const name of todo) {
    const { name: label } = MODELS[name];
    let shownAt = 0;
    if (!json) process.stdout.write(`下載 ${label}…\n`);
    try {
      await download(name, (done, total) => {
        if (Date.now() - shownAt < 250 && done !== total) return;
        shownAt = Date.now();
        if (json) say({ state: 'progress', model: name, done, total });
        else if (total) process.stdout.write(`\r  ${Math.floor((done / total) * 100)}%（${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB）`);
      });
      if (!json) process.stdout.write(`\r  ${label} 好了${' '.repeat(24)}\n`);
    } catch (err) {
      if (json) say({ state: 'error', model: name, message: err.message });
      else process.stderr.write(`\n${err.message}\n`);
      process.exitCode = 1;
      return;
    }
  }
  if (json) say({ state: 'done' });
}

// 直接執行才跑（從 ~/jarvis-voice 這種 symlink 叫也算）
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
