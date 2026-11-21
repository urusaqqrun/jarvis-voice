// OpenAI 一般轉寫（預設 gpt-transcribe）：每講完一句，把那句的音訊包成 WAV 上傳 /v1/audio/transcriptions。
// 整句一次看完，不用邊聽邊猜；價格約是即時版的四分之一。
// 句子可以同時上傳，回來的字照講的順序貼。
// 提早送：listen 在停了 0.4 秒（暫定斷句）時呼叫 speculate()，先把到這裡的聲音送出去；又開口就 discard()，
// 沒有的話 0.85 秒切句時 commit() 直接用先送的那份（後面多的只有靜音），省掉等確定講完的 0.45 秒。
// hedge：每次同時送幾份、誰先回用誰（core/hedge.mjs），砍掉偶爾特別慢的那幾次。
// 沒網路（連不上 OpenAI）：重試一次還是不行，這句改用 fallback（本機 SenseVoice）認，不丟掉；
// 剛斷過網（OFFLINE_MS 內）就不再等重試，直接用本機的（11/20 斷網七分鐘，那段講的全部沒寫）。

import { hedge as hedged } from '../../core/hedge.mjs';
import { networkError } from '../../core/net.mjs';

const MIN_BYTES = 24000 * 2 * 0.15; // 不到 0.15 秒當雜音
const TIMEOUT_MS = 20_000;
const RETRY_MS = 800;
const OFFLINE_MS = 30_000;

export function wavFromPcm16(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk 長度
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 單聲道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// fallback(pcm24k) → 本機認到的字（Promise）；沒有本機模型給 null
export function createBatchEngine({ apiKey, model = 'gpt-transcribe', languages = [], prompt = '', keywords = [], hedge = 1, fallback = null, onFinal, onError, log }) {
  const url = process.env.VOICE_DICTATION_OPENAI_HTTP_URL || 'https://api.openai.com/v1/audio/transcriptions';
  let chunks = [];
  let bytes = 0;
  let nextSeq = 0;
  let deliverSeq = 0;
  let inflight = 0;
  let closed = false;
  let offlineAt = 0; // 上次連不上 OpenAI 的時間
  const results = new Map(); // seq → { text, info }；失敗是 null（錯誤已經記過）
  let early = null; // 提早送的那份：{ bytes, started, promise, abort }

  // 照講的順序交出去；轉出空字串也交（listen 會記「轉寫結果：（空的）」），每一句的下落都看得到
  // info：commit 時給的 meta 加上 { ms（從送出到回來）, early（是不是用提早送的那份） }
  function deliver() {
    while (results.has(deliverSeq)) {
      const r = results.get(deliverSeq);
      results.delete(deliverSeq);
      deliverSeq += 1;
      if (r === null) continue;
      if (closed) log(`轉寫引擎已經換掉，這句沒寫：${r.text || '（空的）'}`);
      else onFinal(r.text, r.info);
    }
  }

  async function transcribe({ wav, signal }) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', model);
    form.append('response_format', 'json');
    // gpt-transcribe 用 languages[]（取代單一的 language）、keywords[]（一詞一欄）
    for (const lang of languages) form.append('languages[]', lang);
    for (const word of keywords) form.append('keywords[]', word);
    if (prompt) form.append('prompt', prompt);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = networkError(err, 'OpenAI');
      if (!reason) throw err;
      const error = new Error(reason);
      error.offline = true;
      throw error;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const message = detail.match(/"message":\s*"([^"]+)"/)?.[1] ?? detail.slice(0, 160);
      const error = new Error(`OpenAI 轉寫失敗（HTTP ${res.status}）${message ? `：${message}` : ''}`);
      error.retry = res.status === 429 || res.status >= 500;
      throw error;
    }
    const body = await res.json();
    return typeof body.text === 'string' ? body.text : '';
  }

  const send = hedged(transcribe, hedge);
  const start = (wav) => {
    const controller = new AbortController();
    return { promise: send({ wav, signal: controller.signal }), abort: () => controller.abort() };
  };

  // early：提早送的那份（commit 時還有效）。它失敗了就用整句重送
  async function run(seq, wav, meta, sent = null) {
    inflight += 1;
    const started = sent?.started ?? Date.now();
    try {
      let text;
      let usedEarly = !!sent;
      try {
        try {
          text = await (sent ?? start(wav)).promise;
        } catch (err) {
          if (err.retry === false) throw err;
          if (err.offline && Date.now() - offlineAt < OFFLINE_MS) throw err; // 剛斷過網：不等重試
          await new Promise((r) => setTimeout(r, err.offline ? RETRY_MS : 1000)); // 網路或伺服器問題重試一次
          usedEarly = false;
          text = await start(wav).promise;
        }
      } catch (err) {
        if (!err.offline) throw err;
        offlineAt = Date.now();
        const local = fallback?.(Buffer.from(wav.subarray(44)));
        if (!local) throw err;
        text = await local;
        log(`${err.message}：這句改用本機辨識（${((wav.length - 44) / 48000).toFixed(1)} 秒音訊用 ${Date.now() - started} ms）`);
        onError(`${err.message}，這句改用本機辨識`);
        results.set(seq, { text, info: { ...meta, ms: Date.now() - started, early: false, local: true } });
        return;
      }
      offlineAt = 0;
      const seconds = ((usedEarly ? sent.bytes : wav.length - 44) / 48000).toFixed(1);
      log(`OpenAI 一般轉寫 ${seconds} 秒音訊用 ${Date.now() - started} ms${usedEarly ? '（停 0.4 秒就先送的那份）' : ''}${hedge > 1 ? `（同時送 ${hedge} 份）` : ''}`);
      results.set(seq, { text, info: { ...meta, ms: Date.now() - started, early: usedEarly } });
    } catch (err) {
      log(`${err.message}（這句沒寫）`);
      onError(err.message);
      results.set(seq, null);
    } finally {
      inflight -= 1;
      deliver();
    }
  }

  const dropEarly = () => { early?.abort(); early = null; };

  return {
    append(buffer) { chunks.push(buffer); bytes += buffer.length; },
    // 暫定斷句：到目前為止的聲音先送出去（不清掉，commit 時還要用）
    speculate() {
      if (early || !apiKey) return false;
      const pcm = Buffer.concat(chunks, bytes);
      if (pcm.length < MIN_BYTES) return false;
      early = { bytes: pcm.length, started: Date.now(), ...start(wavFromPcm16(pcm)) };
      // 還沒 commit 前失敗不用記：commit 時會重送整句
      early.promise.catch(() => {});
      return true;
    },
    // 又開口了：先送的那份作廢
    discard() {
      if (!early) return false;
      dropEarly();
      return true;
    },
    // meta：listen 給的這句的資料（例如講完的時間），轉完跟字一起交回 onFinal
    commit(meta = {}) {
      const pcm = Buffer.concat(chunks, bytes);
      chunks = [];
      bytes = 0;
      const sent = early;
      early = null;
      if (!apiKey) {
        onError('沒有 OpenAI API key：從選單「設定自己的 key…」貼上（或設定檔 openai.apiKey、openai.apiKeyFile、環境變數 OPENAI_API_KEY）');
        return;
      }
      if (pcm.length < MIN_BYTES) {
        sent?.abort();
        log(`這句只有 ${(pcm.length / 48000).toFixed(2)} 秒，當雜音沒送轉寫`);
        return;
      }
      void run(nextSeq++, wavFromPcm16(pcm), meta, sent);
    },
    flush() {},
    busy: () => inflight > 0 || results.size > 0,
    housekeeping() {},
    // 這句不要（聲紋不像使用者）：不送轉寫，先送的那份也作廢
    skip() { chunks = []; bytes = 0; dropEarly(); },
    close() { closed = true; chunks = []; bytes = 0; dropEarly(); },
  };
}
