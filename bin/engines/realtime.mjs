// 雲端即時轉寫：OpenAI Realtime 的 transcription 連線（openai 直連，或經 JarvisVoice 伺服器、平行沙盒 control 轉送）。
// 連線、送音、重連補送都在核心（core/transcription.mjs，跟 網頁版、平行沙盒同一份）；這裡只接 Mac 小程式的介面：
// listen.mjs 本機斷句，講話中 append、講完一句 commit，拿到一句的字就 onFinal。
// 整天開著：有聲音才連，安靜夠久、連線快到 10 分鐘上限時先關（housekeeping）。

import { createTranscriber, permanentError } from '../../core/transcription.mjs';
import { AccountError, accountSession } from '../account.mjs';

// 放棄之後（連線一直被拒、key 錯）隔這麼久才再試
const RETRY_AFTER_FAIL_MS = 5000;

// connector() 回傳 { url, headers?, sessionUpdate? }；sessionUpdate 是開線後第一個送出的設定。
export function createRealtimeEngine({ connector, onFinal, onError, log }) {
  let transcriber = null;
  let failedAt = 0;

  const current = () => {
    if (transcriber && !transcriber.failed) return transcriber;
    if (Date.now() - failedAt < RETRY_AFTER_FAIL_MS) return null;
    transcriber = createTranscriber({
      connect: connector,
      lazy: true,
      onFinal: (text) => onFinal(text),
      onError: (error) => {
        failedAt = Date.now();
        onError(`轉寫連線失敗：${error.message}`);
      },
      log: (message) => log(message),
    });
    return transcriber;
  };

  return {
    append(bytes) { current()?.append(bytes); },
    commit() {
      const t = current();
      if (!t) { log('轉寫連線剛失敗，這句沒送'); return; }
      t.commit({ startMs: 0, endMs: 0 });
    },
    // 這句不要（聲紋不像使用者）：聲音已經串流出去了，照樣 commit 讓連線的緩衝清掉，回來的字丟掉
    skip() {
      const t = current();
      if (!t) return;
      t.discard(t.commit({ startMs: 0, endMs: 0 }));
    },
    flush() { transcriber?.flush(); },
    busy: () => !!transcriber && !transcriber.failed && transcriber.busy(),
    // 每輪主迴圈呼叫：安靜夠久、或連線快到 10 分鐘上限時先關
    housekeeping({ active, quietForMs, speaking }) { transcriber?.idle({ active, quietForMs, speaking }); },
    close() { transcriber?.close(); transcriber = null; },
  };
}

// OpenAI 直連：跟平行沙盒 control 送給 OpenAI 的設定一樣（internal/boxes/transcription.go 的 sessionUpdate）。
export function openaiConnector({ apiKey, model = 'gpt-live-transcribe', languages = [] }) {
  return async () => {
    if (!apiKey) throw permanentError('沒有 OpenAI API key：從選單「設定自己的 key…」貼上（或設定檔 openai.apiKey、環境變數 OPENAI_API_KEY）');
    const transcription = { model, delay: 'low' };
    if (languages.length) transcription.languages = languages;
    return {
      url: process.env.VOICE_DICTATION_OPENAI_URL || 'wss://api.openai.com/v1/realtime?intent=transcription',
      headers: { Authorization: `Bearer ${apiKey}` },
      sessionUpdate: {
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription } },
        },
      },
    };
  };
}

// JarvisVoice 帳號：先確認登入與點數（/voice/check，60 秒內問過不再問），再帶 token header 連 JarvisVoice 伺服器的 /ws/transcription；
// session 設定由後端送，逐字稿後端已轉台灣正體，照錄音分鐘數扣點。沒登入、登入失效、點數不足都直接放棄並說明（重試也沒用）。
export function accountConnector({ apiUrl, language = '' }) {
  return async () => {
    try {
      return await accountSession(apiUrl).transcriptionTarget({ language });
    } catch (err) {
      if (err instanceof AccountError) throw permanentError(err.message);
      throw err;
    }
  };
}

// 平行沙盒：先用 API key 換一分鐘的語音 token，再連 control 的 /v1/transcription（session 設定由 control 送）。
export function parallelSandboxConnector({ apiKey, apiUrl }) {
  return async () => {
    if (!apiKey) throw permanentError('沒有平行沙盒 API key（設定檔 parallelsandbox.apiKey 或 ~/.claude.json 的 parallelsandbox MCP）');
    const res = await fetch(`${apiUrl}/v1/transcription/token`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status === 401 || res.status === 403) throw permanentError(`平行沙盒 API key 不對（HTTP ${res.status}）`);
    if (!res.ok) throw new Error(`換語音 token 失敗（HTTP ${res.status}）`);
    const { token } = await res.json();
    return { url: `${apiUrl.replace(/^http/, 'ws')}/v1/transcription?t=${encodeURIComponent(token)}` };
  };
}
