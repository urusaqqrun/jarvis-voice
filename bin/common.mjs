// Mac 小程式的共用部分：收音的取樣率、ffmpeg 位置，選單列有沒有在讀 stdout；斷句在核心。

import { existsSync } from 'node:fs';

export const SAMPLE_RATE = 24000;
export const BATCH_SAMPLES = 2400; // 100 ms 一批，跟 app 的 AudioWorklet 一樣
export const BATCH_BYTES = BATCH_SAMPLES * 2;

export function findFfmpeg() {
  for (const p of [process.env.FFMPEG_PATH, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (p && existsSync(p)) return p;
  }
  return 'ffmpeg';
}

// 選單列小程式有沒有在讀常駐程式的 stdout：Node 在 Mac 上寫 pipe 是非同步的，對方不讀就一直堆在記憶體、聽寫照常，
// 只看得出 writableLength 不是 0（pipe 的 64KB 已經塞滿）。連續 stuckMs 都沒清空才算卡住（11/13 起選單列不讀，圖示停在
// 「啟動中」、小框不出來，四天沒人發現）。回傳 (還沒送出的 bytes, 現在) => 卡住了沒
export function createOutputWatch({ stuckMs = 30_000 } = {}) {
  let since = 0;
  return (queued, now = Date.now()) => {
    if (!queued) { since = 0; return false; }
    if (!since) since = now;
    return now - since >= stuckMs;
  };
}

// 本機斷句在核心（core/turns.mjs），跟平行沙盒 app 同一套。
export { AudioTurnDetector, TurnSplitter } from '../core/turns.mjs';
