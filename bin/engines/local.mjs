// 本機轉寫：sherpa-onnx 跑 SenseVoice-Small（普通話、英文、粵語、日文、韓文），聲音不離開這台電腦、不花錢。
// 每句（listen.mjs 切好的）整句丟進去辨識，一句一句照順序出字。

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export function createLocalEngine({ model, language = 'auto', threads = 2, onFinal, onError, log }) {
  const modelFile = join(model, 'model.int8.onnx');
  const tokens = join(model, 'tokens.txt');
  let sherpa = null;
  let recognizer = null;
  let resampler = null;
  let failed = '';
  try {
    if (!existsSync(modelFile) || !existsSync(tokens)) throw new Error(`找不到本機模型：${model}（重跑 install.sh 會下載）`);
    sherpa = require('sherpa-onnx-node');
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: modelFile, language, useInverseTextNormalization: 1 },
        tokens,
        numThreads: threads,
        provider: 'cpu',
        debug: 0,
      },
    });
  } catch (err) {
    failed = err.message;
    log(failed);
    onError(failed);
  }

  let chunks = [];
  let bytes = 0;
  const queue = []; // 每句的 Float32Array（16kHz）
  let decoding = false;

  // 第一次辨識要暖機兩三秒，先拿半秒靜音跑一次，第一句話才不會慢
  let warming = recognizer
    ? (async () => {
      try {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples: new Float32Array(8000), sampleRate: 16000 });
        await recognizer.decodeAsync(stream);
      } catch { /* 暖機失敗就等第一句再說 */ }
    })()
    : Promise.resolve();

  const to16k = (buffer) => {
    const i16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
    const f32 = Float32Array.from(i16, (v) => v / 32768);
    resampler ??= new sherpa.LinearResampler(24000, 16000);
    resampler.reset(); // 每句各自一段，不接上一句的尾巴
    return resampler.flush(f32);
  };

  async function drain() {
    if (decoding) return;
    decoding = true;
    try {
      await warming;
      warming = Promise.resolve();
      while (queue.length) {
        const samples = queue.shift();
        const started = Date.now();
        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: 16000 });
        await recognizer.decodeAsync(stream);
        const { text } = recognizer.getResult(stream);
        log(`本機辨識 ${(samples.length / 16000).toFixed(1)} 秒音訊用 ${Date.now() - started} ms`);
        onFinal(text ?? '');
      }
    } catch (err) {
      log('本機辨識失敗，這句沒寫：', err.message);
      onError(`本機辨識失敗：${err.message}`);
    } finally {
      decoding = false;
    }
  }

  return {
    append(buffer) { chunks.push(buffer); bytes += buffer.length; },
    commit() {
      const whole = Buffer.concat(chunks, bytes);
      chunks = [];
      bytes = 0;
      if (!recognizer) {
        log(`本機模型沒載入，這句沒寫${failed ? `：${failed}` : ''}`);
        if (failed) onError(failed);
        return;
      }
      if (whole.length < 3200) { // 不到 0.07 秒，當雜音
        log(`這句只有 ${(whole.length / 48000).toFixed(2)} 秒，當雜音沒送辨識`);
        return;
      }
      queue.push(to16k(whole));
      void drain();
    },
    flush() {},
    busy: () => queue.length > 0 || decoding,
    housekeeping() {},
    skip() { chunks = []; bytes = 0; }, // 這句不要（聲紋不像使用者）
    close() { chunks = []; bytes = 0; queue.length = 0; },
  };
}

// 即時預覽：雲端轉寫時，講話中用本機 SenseVoice 認目前這句（一句 0.15 秒左右）：游標在框裡就邊講邊打，不然在游標旁的小框顯示。
// 載不起來（沒下載模型）就沒有預覽，不算錯。recognize(pcm24k) → 認出來的字（簡體，呼叫端轉正體）。
// language：auto 會把開頭的「嗯」認成日文「うん」，知道講什麼語言就給（zh、en、ja、ko、yue）
const PREVIEW_MAX_SECONDS = 15; // 很長的一句只認最後 15 秒，免得越講越慢
export function createPreviewer({ model, language = 'auto', threads = 2, log = () => {} }) {
  let recognizer = null;
  let sherpa = null;
  try {
    const modelFile = join(model, 'model.int8.onnx');
    const tokens = join(model, 'tokens.txt');
    if (!existsSync(modelFile) || !existsSync(tokens)) {
      log(`沒有本機模型（${model}），講話中不顯示即時預覽`);
      return null;
    }
    sherpa = require('sherpa-onnx-node');
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { senseVoice: { model: modelFile, language, useInverseTextNormalization: 1 }, tokens, numThreads: threads, provider: 'cpu', debug: 0 },
    });
  } catch (err) {
    log(`即時預覽的本機模型載不起來，不顯示預覽：${err.message}`);
    return null;
  }
  const resampler = new sherpa.LinearResampler(24000, 16000);
  return {
    async recognize(pcm) {
      const keep = PREVIEW_MAX_SECONDS * 48000;
      const tail = pcm.length > keep ? pcm.subarray(pcm.length - keep) : pcm;
      const i16 = new Int16Array(tail.buffer, tail.byteOffset, Math.floor(tail.length / 2));
      resampler.reset();
      const samples = resampler.flush(Float32Array.from(i16, (v) => v / 32768));
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      await recognizer.decodeAsync(stream);
      return recognizer.getResult(stream).text ?? '';
    },
  };
}
