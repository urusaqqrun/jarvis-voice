#!/usr/bin/env node
// 語音輸入的常駐程式（由選單列小程式「JarvisVoice」帶起來）：自動收音，講完就寫進目前游標所在的輸入框——
// 在哪個 app、哪個欄位，字就進哪裡；只貼不送出。開會、通話的 app 在最前面或按了暫停時關麥克風。
// 整台電腦同時只跑一個（鎖檔）。
//
// 三層：
//   1. 語音輸入：停頓 0.85 秒切一句，轉寫完就貼（AI 整理關著時）。
//   2. AI 整理（ai.enabled）：停頓超過 ai.segmentPauseMs 算一段講完，讀游標前後與 app、視窗、網址，
//      整段交給 AI（OpenAI／DeepSeek／Claude）整理再貼；選取了字又講指令就改寫選取的字。原稿留著可以換回。
//   3. 自動找輸入框（autoFocus）：游標不在輸入框時，挑視窗裡最像要寫字的輸入框，對焦後寫進去。
//
// 速度（speed，cubelv_docs/計劃/2026-10-19_JarvisVoice語音加速規劃.md）：能先做的先做，猜錯就丟掉重來，結果跟原本一樣。
//   - 開口時就先讀上下文（游標前後、畫面，截圖認字的 app 要 1 秒）、先把轉寫與 AI 的連線接好。
//   - 停 0.4 秒就先把這句送去轉寫；到 0.85 秒確定講完就用這份，中間又開口就作廢。
//   - 字一回來就開始 AI 整理（游標不在輸入框時同時挑好要寫的框）；整理好時已經停了 1.2 秒就直接貼，
//     又開口就作廢、等整段講完一起整理。
//   - 轉寫、AI 整理每次同時送兩份，誰先回用誰。
//   - 字先進輸入框（規則在核心 core/draft.mjs）：講話中就把本機預覽認到的字打進游標所在的輸入框（speed.live），AI 整理好再把那段換掉，
//     框裡的字只換一次（預覽少一截或沒有預覽的句子，準的轉寫回來先寫，speed.draft）；想送就直接送，不用等。已經送出、自己改過、游標移走、換了 app 就不再改。
//     游標不在輸入框、選取了字、開頭講「指令」時不先寫，照原本整理好才寫。
//   - 游標旁的小框（app/ui.js）：寫聽到、還沒進輸入框的字（本機 SenseVoice 預覽）；字都已經打進框就只寫狀態（邊講邊打、整理中、已整理）。指令、出錯照舊。
//   每次貼上 log 記一行「速度：講完到貼上 X 秒（字回來、整理好、貼上各花多少）」（只記 log，小框不顯示秒數）。
//
// 轉寫引擎看設定檔（bin/config.mjs）：local 本機 SenseVoice、openai 自己的 key（預設 gpt-transcribe 一般轉寫，
// 也可以選 gpt-live-transcribe 即時）、cubelv（用 CubeLV 登入，扣點數，bin/cubelv.mjs）、parallelsandbox。設定檔改了會自動換。
// 狀態寫在 status.json 給狀態列讀；有 paused 檔就暫停；有 revert-request 檔就把上一段換回原稿。
// stdout 每行一個 JSON（state、settings、hud、bubble、draft、pasted、kept、skipped）。
// 選項：--app 由選單列小程式帶起（log 寫進 listen.log，小程式不在了就結束）。
// 測試選項：--file <音檔> 用音檔代替麥克風、讀完收尾結束；--dry-paste 只印不貼；--always 不看前景 app；
// --pid <pid> 配 --file：只寫進這個 app（端到端測試的測試視窗），讀它的上下文、它到最前面才貼，不會貼到別的 app。

import { execFile, execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createAx } from './ax.mjs';
import { createMacAgentScreen } from './agent-screen.mjs';
import { TurnSplitter, BATCH_BYTES, SAMPLE_RATE, findFfmpeg } from './common.mjs';
import { STATE_DIR, aiAvailable, aiKey, appAllowed, configMtime, cubelvAccount, isLiveModel, loadConfig, styleFor } from './config.mjs';
import { DEFAULT_MODELS, PROVIDER_NAMES, editSegment, service } from './editor.mjs';
import { DEFAULT_URLS } from '../core/providers.mjs';
import { createBatchEngine } from './engines/batch.mjs';
import { createLocalEngine, createPreviewer } from './engines/local.mjs';
import { VOICEPRINT_MODEL, createVoiceprintFilter } from './voiceprint.mjs';
import { createAudioDebug } from './audio-debug.mjs';
import { createRealtimeEngine, cubelvConnector, openaiConnector, parallelSandboxConnector } from './engines/realtime.mjs';
import { appendHistory } from './history.mjs';
import { createDecider, intentQuestion } from './decide.mjs';
import { createLearner } from './learn.mjs';
import { createVocabAuto } from './vocab-auto.mjs';
import { finishText, isSpeech, withSpacing } from './text.mjs';
// 一段話講完之後怎麼處理、幾句合成一段、小框的階段：都在核心（CubeLV、平行沙盒同一份），這裡只接 Mac 的接頭
import { judgeInField, judgeUtterance, pickTarget, planOutput } from '../core/flow.mjs';
import { createSegmenter, heardText, speechBubble } from '../core/segment.mjs';
import { createDraftWriter } from '../core/draft.mjs';
import { bubbleContent, stepText } from '../core/bubble.mjs';
import { runAgent } from '../core/agent.mjs';

const LOCK = join(STATE_DIR, 'listener.lock');
const PAUSED = join(STATE_DIR, 'paused');
const REVERT = join(STATE_DIR, 'revert-request');
const VOICEPRINT_FILE = join(STATE_DIR, 'voiceprint.json');
const VOICEPRINT_RESET = join(STATE_DIR, 'voiceprint-reset'); // 選單「重錄我的聲紋」
const STATUS = join(STATE_DIR, 'status.json');
const LAST = join(STATE_DIR, 'last.txt');
const LOG = join(STATE_DIR, 'listen.log');
const POLL_MS = 500;
const SEGMENT_CHECK_MS = 100;
const HOLD_MS = 60_000; // 寫的時候前景是不收音的 app（例如開會），最多等一分鐘回來再寫
const MAX_SEGMENT_CHARS = 1500; // 一直講不停太長就先整理這一段
const MAC_PEAK_OVER_NOISE = 9; // 還沒開口時尖峰到底噪的 9 倍就算有人聲（10/19 實測：風扇聲裡沒人講話最大約 7.5 倍，正常講話 10 倍以上）

const argv = process.argv.slice(2);
const fileIndex = argv.indexOf('--file');
const inputFile = fileIndex >= 0 ? argv[fileIndex + 1] : null;
const dryPaste = argv.includes('--dry-paste');
const always = argv.includes('--always') || !!inputFile;
const pidIndex = argv.indexOf('--pid');
const targetPid = inputFile && pidIndex >= 0 ? Number(argv[pidIndex + 1]) : 0;
const appMode = argv.includes('--app');
const parentPid = process.ppid;

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (...parts) => {
  const line = `[listen] ${parts.join(' ')}\n`;
  if (!appMode) { process.stderr.write(line); return; }
  try { appendFileSync(LOG, `${new Date().toISOString()} ${line}`); } catch { /* 寫不進就算了 */ }
};
const exec = (cmd, args, timeout = 3000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? '' : stdout));
});

// ---- 鎖：同時只跑一個 ----

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

function takeLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(LOCK, 'utf8').trim());
      if (pid && pid !== process.pid && isAlive(pid)) return false;
      try { unlinkSync(LOCK); } catch { /* 別人剛清掉 */ }
    }
  }
  return false;
}

function releaseLock() {
  try { if (readFileSync(LOCK, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK); } catch { /* 已經不在 */ }
}

// ---- 即時狀態（選單列小程式顯示：說話中、已貼上、沒有輸入框）----

let stopping = false;
let hudMode = '';

// 交給選單列小程式（--app 時從 stdout 送出）；hearing、listening、hide、error:<訊息>、pasted、nofield、
// level:<0–1>（說話中的音量，每 0.1 秒）、working／idle（辨識中開始、結束）
function hudWrite(line) {
  if (appMode || process.env.VOICE_DICTATION_HUD) emit({ type: 'hud', line }); // VOICE_DICTATION_HUD：測試看選單列收到什麼
}

function hudShow(mode) {
  if (mode === hudMode) return;
  hudMode = mode;
  hudWrite(mode);
  if (mode === 'hide') bubble('hide');
  else if (mode.startsWith('error:')) bubble('error', { text: mode.slice(6) });
}

// 游標旁的小框（app/ui.js 畫）。有哪些階段、標題和內文寫什麼、停多久都在核心（core/bubble.mjs，CubeLV 的頂端 toast 同一份），
// 這裡照系統語言算好交給 ui.js：{ state, title, body, tone, loud, busy, result, holdMs, at }。
// at：游標（拿不到就是視窗）在螢幕上的位置 { x, y, w, h, kind: caret | window }（左上角原點），小框放在它下面；null 就放畫面下方中間
const LANG = process.env.VOICE_DICTATION_LANG || process.env.LANG || '';
const ZH = /^zh/i.test(LANG);
let bubbleKey = '';
let lastAnchor = null;
const bubbleOn = () => config.speed.bubble && (appMode || !!process.env.VOICE_DICTATION_HUD);
function bubble(state, { text = '', detail = '', speaker = '', typing = false } = {}) {
  if (!bubbleOn()) return;
  const key = `${state}|${text}|${detail}|${speaker}|${typing}|${JSON.stringify(lastAnchor)}`;
  if (key === bubbleKey) return;
  bubbleKey = key;
  const content = state === 'hide' ? null : bubbleContent({ state, text, detail, speaker, typing }, ZH ? 'zh' : 'en');
  emit({ type: 'bubble', state, ...(content ?? {}), at: lastAnchor });
}

// 讀到上下文就記下游標在哪，小框跟著放；游標在框裡（會邊講邊打）小框只寫還沒進框的字
let fieldEditable = false;
function noteAnchor(ctx) {
  if (!ctx) return;
  fieldEditable = !!ctx.field?.editable && !ctx.field.selected && !ctx.field.secure;
  if (ctx.field?.editable && ctx.field.caret) lastAnchor = { ...ctx.field.caret, kind: 'caret' };
  else if (ctx.frame) lastAnchor = { ...ctx.frame, kind: 'window' };
}

// ---- 設定與引擎 ----

let { config, error: configError } = loadConfig();
let configStamp = configMtime(config);
let engine = null;

// AI 整理開著而且有 key（或用 CubeLV 登入了）才走第二層
const aiReady = () => config.ai.enabled && aiAvailable(config);
const aiSettings = () => ({
  provider: config.ai.provider,
  model: config.ai.models[config.ai.provider] || '',
  apiKey: aiKey(config),
  timeoutMs: config.ai.timeoutMs,
  cubelvUrl: config.cubelv.apiUrl,
});

function announceSettings() {
  const provider = config.ai.provider;
  const model = config.ai.models[provider] || DEFAULT_MODELS[provider];
  const deciderName = config.jev.apiKey ? 'Jev' : aiReady() ? PROVIDER_NAMES[provider] : '';
  const account = cubelvAccount(config);
  emit({
    type: 'settings',
    engine: config.engine,
    ai: { enabled: config.ai.enabled, provider, ready: aiReady() },
    draft: !!config.speed.draft,
    autoFocus: config.autoFocus,
    commands: config.commands,
    decider: deciderName,
    cubelv: { loggedIn: !!account, email: account?.email ?? '' },
    voiceprint: { enabled: !!config.voiceprint.enabled, ready: !!voiceprint, enrolled: !!voiceprint?.enrolled() },
    // 各家有沒有 key（哪裡設的都算）：選單選了沒有 key 的那家，直接開「設定自己的 key…」的對話框
    keys: { openai: !!aiKey(config, 'openai'), deepseek: !!aiKey(config, 'deepseek'), claude: !!aiKey(config, 'claude'), jev: !!config.jev.apiKey },
  });
  const missing = provider === 'cubelv' ? '，但還沒用 CubeLV 登入，先不整理' : '，但沒有 key，先不整理';
  log(`AI 整理：${config.ai.enabled ? `${PROVIDER_NAMES[provider]}（${model}）${aiReady() ? '' : missing}` : '關'}；`
    + `自動找輸入框：${config.autoFocus ? '開' : '關'}；指令模式：${config.commands ? (aiReady() ? '開' : '開，但要先開 AI 整理') : '關'}；`
    + `第三層決策：${deciderName || '沒有（照規則）'}`);
  // 沒有 key 不算錯：只跑第一層，選單會寫「（沒有 key）」
}

let previewer = null;
let previewModel = '';

function startEngine() {
  engine?.close();
  const callbacks = {
    log,
    onError: (message) => setError(message),
    // info：引擎交回 commit 時給的 meta（turn、voiceEndAt）加上 ms、early（整句引擎才有）
    onFinal: (raw, info = {}) => {
      const turn = finishedPreview(info.turn);
      const heard = { ...info, heardAt: Date.now() };
      const text = finishText(raw, {
        output: config.output,
        replacements: config.replacements,
        alreadyTraditional: config.engine === 'parallelsandbox' || config.engine === 'cubelv',
      });
      if (!isSpeech(text)) {
        log(`轉寫結果：${text ? `「${text}」只有標點` : '（空的）'}，這句沒有字，不寫`);
        void drafts.drop(turn);
        showHeard();
        segmenter.check();
        return;
      }
      log(`轉寫結果：${text}`);
      if (aiReady()) void addSentence(text, heard, turn).catch((err) => log(`這句沒併進這段：${err?.stack || err}`));
      else enqueueOutput({ kind: 'text', text, heard });
    },
  };
  if (config.engine === 'local') engine = createLocalEngine({ ...config.local, ...callbacks });
  else if (config.engine === 'openai' && isLiveModel(config.openai.model)) engine = createRealtimeEngine({ connector: openaiConnector(config.openai), ...callbacks });
  else if (config.engine === 'openai') engine = createBatchEngine({ ...config.openai, hedge: config.speed.hedge, ...callbacks });
  else if (config.engine === 'cubelv') engine = createRealtimeEngine({ connector: cubelvConnector({ ...config.cubelv, language: cubelvLanguage() }), ...callbacks });
  else engine = createRealtimeEngine({ connector: parallelSandboxConnector(config.parallelsandbox), ...callbacks });
  // 講話中的即時預覽：雲端轉寫才需要（本機轉寫本來就快），有小框才看得到
  const wantPreview = config.speed.preview && bubbleOn() && config.engine !== 'local';
  const previewKey = `${config.local.model}|${previewLanguage()}`;
  if (!wantPreview) { previewer = null; previewModel = ''; }
  else if (previewModel !== previewKey) {
    previewModel = previewKey;
    previewer = createPreviewer({ model: config.local.model, language: previewLanguage(), log });
  }
  log(`轉寫引擎：${config.engine}${config.engine === 'openai' ? `（${config.openai.model}，詞彙 ${config.openai.keywords.length} 個）` : ''}`);
  startVoiceprint();
  if (configError) setError(configError);
  announceSettings();
}

// CubeLV 轉寫的辨識語言：設定檔 openai.languages 有寫就照它，沒寫看介面語言（中文是 zh-Hant＝繁中夾英文），其他讓模型自己判斷
function cubelvLanguage() {
  const langs = config.openai.languages.map((l) => String(l).toLowerCase());
  if (langs.some((l) => l.startsWith('zh'))) return 'zh-Hant';
  if (langs.length === 1 && langs[0].startsWith('ja')) return 'ja';
  if (langs.length === 1 && langs[0].startsWith('en')) return 'en';
  return !langs.length && /^zh/i.test(process.env.VOICE_DICTATION_LANG || process.env.LANG || '') ? 'zh-Hant' : '';
}

// 本機預覽（SenseVoice）的語言：設定檔 local.language 有寫就照它，沒寫照轉寫的語言（auto 會把開頭的「嗯」認成日文打進框）
function previewLanguage() {
  if (config.local.language && config.local.language !== 'auto') return config.local.language;
  return { 'zh-Hant': 'zh', ja: 'ja', en: 'en' }[cubelvLanguage()] ?? 'auto';
}

function reloadConfigIfChanged() {
  const stamp = configMtime(config);
  if (stamp === configStamp) return;
  if (engine?.busy()) return; // 有句子還在轉寫，等轉完再換（換引擎會丟掉轉到一半的）
  // 正在講、或有聲音已經交給引擎還沒切句：等這句講完再換。換引擎會把已經交出去的聲音丟掉
  // （10/25 詞彙表自動加詞在講話中途換引擎，那句講了 1.9 秒只轉到 1.4 秒）
  if (detector.speaking || detector.starting || pendingBytes) return;
  configStamp = stamp;
  ({ config, error: configError } = loadConfig());
  configStamp = configMtime(config);
  startEngine();
}

// ---- 狀態 ----

let state = '';
let stateMessage = '';
let frontActive = false; // 目標 app 在最前面且沒暫停
let lastError = null; // { message, at }：錯誤在狀態列留 15 秒
function setError(message) {
  lastError = { message, at: Date.now() };
  setState('error', message);
}
function setState(next, message = '') {
  if (next === state && message === stateMessage) return;
  state = next;
  stateMessage = message;
  emit({ type: 'state', state, message, engine: config.engine });
  if (state === 'listening') hudShow(detector.speaking ? 'hearing' : 'listening');
  else if (state === 'error' && frontActive) hudShow(`error:${message}`);
  else hudShow('hide');
  try {
    const tmp = `${STATUS}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ state, message, engine: config.engine, pid: process.pid, at: Date.now() }));
    renameSync(tmp, STATUS);
  } catch { /* 狀態列看不到而已 */ }
}

async function frontApp() {
  const asn = (await exec('/usr/bin/lsappinfo', ['front'])).trim();
  if (!asn) return { bundle: '', pid: 0 };
  const info = await exec('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', '-only', 'pid', asn]);
  return {
    bundle: info.match(/"CFBundleIdentifier"="([^"]*)"/)?.[1] ?? '',
    pid: Number(info.match(/"pid"=(\d+)/)?.[1] ?? 0),
  };
}

// 這個 app 在最前面時要不要收音（VOICE_DICTATION_APPS 給測試用：只認這些）
const allowed = (bundle) => (process.env.VOICE_DICTATION_APPS
  ? process.env.VOICE_DICTATION_APPS.split(',').includes(bundle)
  : appAllowed(config, bundle));

// ---- 收音與切句 ----

let ffmpeg = null;
let captureRetryAt = 0;
// 斷句與開口前 0.4 秒的預錄都在核心（core/turns.mjs 的 TurnSplitter，跟 CubeLV、平行沙盒同一份）
let splitter = new TurnSplitter();
let detector = splitter.detector;
let pendingChunks = [];
let pendingBytes = 0;
let carry = Buffer.alloc(0);
let sentSamples = 0;
let lastSpeechAt = 0;
let lastVoiceAt = 0; // 最後一次真的聽到人聲（算一段講完了沒）
let turnPeak = 0; // 這一句的最大音量（記 log 用）
// 自己 debug 用：存每一句與麥克風的音檔（設定 debug.saveAudio，預設關；bin/audio-debug.mjs）
const audioDebug = createAudioDebug({ enabled: () => !!config.debug?.saveAudio, log });
let batchRms = 0; // 最近一批（0.1 秒）的音量，說話中送給選單列畫聲波
// 音量換成 0–1 給選單列：-50 dB 以下是 0、-10 dB 以上是 1
const levelOf = (rms) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(rms, 1e-6)) + 50) / 40));

// 講話中的音訊邊講邊交給引擎（雲端引擎會先送出去），講完一句再 commit
const stageAudio = () => {
  if (!pendingBytes) return;
  engine.append(Buffer.concat(pendingChunks, pendingBytes));
  pendingChunks = [];
  pendingBytes = 0;
};

// meta 跟著這句走到 onFinal：turn（第幾句，對即時預覽用）、voiceEndAt（最後一次聽到人聲，算「講完到貼上」）
const queueTurn = () => {
  stageAudio();
  engine.commit({ turn: currentTurn, voiceEndAt: lastVoiceAt });
};
const takeAudio = (audio) => {
  for (const b of audio) { pendingChunks.push(b); pendingBytes += b.length; }
};

// 診斷：每 15 秒記一次這段時間的最大音量，看麥克風到底有沒有收到聲音（全 0＝沒權限或被別的程式占住）、
// 有沒有爆音、有幾次太短的聲音沒算成一句
let levelPeak = 0;
let reopenCapture = false;
let levelSince = Date.now();
// 診斷：這 15 秒麥克風實際交來幾秒聲音（少了＝聲音在進到這裡之前就掉了）、程式最久卡住多久（卡住時 ffmpeg 交不出聲音會丟掉）
let receivedBytes = 0;
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
function trackLevel(samples) {
  let peak = 0;
  let sum = 0;
  for (const v of samples) { const a = Math.abs(v) / 32768; if (a > peak) peak = a; sum += a * a; }
  batchRms = Math.sqrt(sum / samples.length);
  if (peak > levelPeak) levelPeak = peak;
  if (Date.now() - levelSince < 15_000) return peak;
  const notes = [];
  if (levelPeak === 0) notes.push('完全沒聲音，多半是剛給麥克風權限前就開了，重開麥克風');
  if (levelPeak >= 0.99) notes.push('有爆音（音量到頂），轉寫可能會錯');
  if (detector.shortBlips) notes.push(`${detector.shortBlips} 次聲音不到 0.18 秒，當雜音沒算成一句`);
  const gotSec = receivedBytes / (SAMPLE_RATE * 2);
  const wallSec = (Date.now() - levelSince) / 1000;
  if (wallSec - gotSec > 0.5) notes.push(`這 ${wallSec.toFixed(1)} 秒只收到 ${gotSec.toFixed(1)} 秒聲音`);
  const stallMs = loopDelay.max / 1e6;
  if (stallMs > 300) notes.push(`程式最久卡住 ${Math.round(stallMs)} ms`);
  receivedBytes = 0;
  loopDelay.reset();
  // 門檻跟著底噪走：記下現在的底噪、開口門檻，和沒算成人聲的聲音最大到多少（講話沒被聽到時看差多少）
  const th = detector.thresholds();
  const gate = `底噪 ${th.noise.toFixed(4)}、開口門檻 RMS ${th.level.toFixed(3)} 或尖峰 ${th.peak.toFixed(3)}；沒算成人聲的最大 RMS ${detector.missLevel.toFixed(3)}、尖峰 ${detector.missPeak.toFixed(3)}`;
  log(`麥克風 15 秒內最大音量 ${levelPeak.toFixed(3)}（${gate}）${notes.length ? `：${notes.join('；')}` : ''}`);
  detector.missLevel = 0;
  detector.missPeak = 0;
  // 權限詢問還沒按允許時開的麥克風，允許之後也一直收到 0：重開一次就好
  if (levelPeak === 0) reopenCapture = true;
  detector.shortBlips = 0;
  levelPeak = 0;
  levelSince = Date.now();
  return peak;
}

function takeBatch(chunk) {
  audioDebug.mic(chunk);
  const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
  const peak = trackLevel(samples);
  const startMs = sentSamples / 24;
  sentSamples += samples.length;
  const wasSpeaking = detector.speaking;
  const { audio, turn, tentative, resumed } = splitter.push(samples, startMs);
  takeAudio(audio);
  if (detector.speaking) lastSpeechAt = Date.now();
  if ((detector.speaking || turn) && detector.lastVoiced) lastVoiceAt = Date.now();
  if (detector.speaking || turn) turnPeak = Math.max(turnPeak, peak);
  if (!wasSpeaking && detector.speaking) speechStarted();
  if (wasSpeaking || detector.speaking) for (const b of audio) { turnAudio.push(b); turnAudioBytes += b.length; }
  if (detector.speaking !== wasSpeaking && state === 'listening') hudShow(detector.speaking ? 'hearing' : 'listening');
  if (detector.speaking && state === 'listening') {
    hudWrite(`level:${levelOf(batchRms).toFixed(2)}`);
    warmUp();
    schedulePreview();
  }
  // 停了 0.4 秒：先比聲紋（不像使用者就不送），再把到這裡的聲音送去轉寫；又開口就作廢
  if (tentative && engine.speculate) {
    turnVerdict = voiceprint ? voiceprint.check(Buffer.concat(turnAudio, turnAudioBytes), (detector.lastVoiceEnd - detector.currentStartMs) / 1000, { dryRun: true }) : null;
    if (!turnVerdict || turnVerdict.pass) { stageAudio(); engine.speculate(); }
  }
  if (resumed) {
    turnVerdict = null;
    if (engine.discard?.()) log('停 0.4 秒先送的轉寫作廢：又開口了');
  }
  if (turn) {
    const sec = (turn.endMs - turn.startMs) / 1000;
    // 停 0.4 秒時已經算過這句的聲紋（之後沒再開口，聲音一樣）：直接記，不再算一次
    const verdict = judgeTurn(sec, turnVerdict?.v);
    turnVerdict = null;
    const loud = `最大音量 ${turnPeak.toFixed(3)}${turnPeak >= 0.99 ? '，爆音' : ''}`;
    turnPeak = 0;
    const audioFile = audioDebug.turn(turnAudio, { verdict: verdict.verdict ?? (verdict.pass ? 'pass' : 'other'), sec });
    if (verdict.pass) {
      log(`切出一句 ${sec.toFixed(1)} 秒（${loud}），送去轉寫${audioFile ? `（音檔 ${audioFile}）` : ''}`);
      queueTurn();
    } else {
      stageAudio();
      engine.skip?.();
      // 小框寫「別人在講話，這句不轉寫」，附上本機預覽聽到的字（看得到擋了什麼）
      const heard = previews.get(currentTurn) ?? '';
      if (audioFile) log(`擋掉的這句：音檔 ${audioFile}，本機預覽聽到「${heard}」`);
      finishedPreview(currentTurn);
      void drafts.drop(currentTurn);
      showHeard(heard);
    }
    turnAudio = [];
    turnAudioBytes = 0;
  }
}

// ---- 只聽使用者的聲音（聲紋，bin/voiceprint.mjs、core/voiceprint.mjs）----

let voiceprint = null;
let voiceprintKey = '';
let turnVerdict = null; // 這句在停 0.4 秒時先比的聲紋（只看不記；切句時用同一個聲紋記，不再算一次）

function startVoiceprint() {
  const { enabled, threshold, minSeconds, shortThreshold } = config.voiceprint;
  const key = enabled ? `${threshold}:${minSeconds}:${shortThreshold}` : '';
  if (key === voiceprintKey) return;
  voiceprintKey = key;
  voiceprint = enabled ? createVoiceprintFilter({
    model: join(STATE_DIR, 'models', 'speaker', VOICEPRINT_MODEL), file: VOICEPRINT_FILE, threshold, minSeconds, shortThreshold, log,
  }) : null;
  lastSpeaker = '';
  if (voiceprint) log(voiceprint.enrolled() ? '只聽你的聲音：開（聲紋已錄好）' : '只聽你的聲音：開，從你講的話在背景學你的聲音（學好之前照常轉寫）');
}

// 小框的小標籤寫是誰講的：最後一句比過聲紋的結果（mine 你說的、short 短句；聲紋還在背景學的時候不標）
let lastSpeaker = '';

// 這句是不是使用者講的：還在錄樣本、太短、像使用者都放行；不像就不轉寫。v：停 0.4 秒時算好的聲紋
function judgeTurn(sec, v = null) {
  if (!voiceprint) return { pass: true };
  const r = v ? voiceprint.commit(v, sec) : voiceprint.check(Buffer.concat(turnAudio, turnAudioBytes), sec);
  if (r.verdict === 'enrolling') log('聲紋還在背景學：這句當樣本，照常轉寫');
  else if (r.verdict === 'enrolled') {
    log(`聲紋樣本錄好了（留下 ${r.kept} 句）：之後不像你的聲音不轉寫`);
    announceSettings();
  } else if (r.verdict === 'other') log(`聲紋不像你（相似度 ${r.score.toFixed(2)}，${sec.toFixed(1)} 秒，${r.ms} ms）：這句不轉寫`);
  else if (r.score !== null) log(`聲紋：${r.verdict === 'short' ? '短句，是你' : '是你'}（相似度 ${r.score.toFixed(2)}，${r.ms} ms）`);
  if (r.pass) lastSpeaker = r.verdict === 'enrolled' ? 'mine' : r.verdict === 'enrolling' ? '' : r.verdict;
  return r;
}

// 開口了：先讀上下文、接好連線；講到一半的提早整理作廢（等整段講完一起整理）
function speechStarted() {
  currentTurn += 1;
  turnAudio = [];
  turnAudioBytes = 0;
  previewedBytes = 0;
  segmenter.drop('又開口了');
  turnVerdict = null;
  void prefetchContext();
  warmUp();
  showHeard();
}

// ---- 講話中的即時預覽：本機 SenseVoice 每多 0.5 秒聲音認一次目前這句。游標在框裡就直接打進框（speed.live），不然寫在游標旁的小框 ----

const PREVIEW_STEP_BYTES = 24000; // 0.5 秒（24 kHz、16-bit）
const LIVE_MIN_BYTES = 48000; // 講滿 1 秒才開始打：別人短短一聲（Yeah、Okay）、雜音不會先打進框
const LIVE_MAX_CHECK_BYTES = 288000; // 講了 6 秒聲紋還不夠像你：這句不再比，講完照草稿寫
// 聲紋要這麼像你才邊講邊打。放行的門檻是 0.3，但 11/04 實測轉出來是空的雜音就在 0.31～0.37、你講的 0.43～0.83；
// 沒到就只是先不打，這句講完照樣寫
const LIVE_MIN_SCORE = 0.42;
let currentTurn = 0; // 第幾句（開口一次加一）
let turnAudio = []; // 這句到目前的聲音
let turnAudioBytes = 0;
let previewedBytes = 0;
let previewBusy = false;
let finalTurn = 0; // 雲端轉寫已經回來的最後一句；比它舊的預覽不再顯示
const previews = new Map(); // 第幾句 → 預覽的字（雲端的字回來就拿掉）
let liveTurn = 0; // 比過聲紋、可以邊講邊打的那句

const liveOn = () => !!previewer && !!config.speed.draft && !!config.speed.live && aiReady();

// 這句認到的字打進框（核心 core/draft.mjs 的 preview；游標不在框裡它會寫不進去，這句就不再試）
function typeLive(turnNo, text, pcm) {
  if (!liveOn() || pcm.length < LIVE_MIN_BYTES) return;
  if (voiceprint?.enrolled() && liveTurn !== turnNo) {
    if (pcm.length > LIVE_MAX_CHECK_BYTES) return;
    const r = voiceprint.check(pcm, pcm.length / (SAMPLE_RATE * 2), { dryRun: true });
    if (!r.pass || (r.score ?? 0) < LIVE_MIN_SCORE) return;
    liveTurn = turnNo;
  }
  // 打進框了，小框就不用再寫這句的字
  drafts.preview(turnNo, text)?.then(() => showHeard());
}

function schedulePreview() {
  if (!previewer || previewBusy || turnAudioBytes - previewedBytes < PREVIEW_STEP_BYTES) return;
  previewBusy = true;
  previewedBytes = turnAudioBytes;
  const turnNo = currentTurn;
  const pcm = Buffer.concat(turnAudio, turnAudioBytes);
  previewer.recognize(pcm).then((raw) => {
    const text = finishText(raw, { output: config.output, replacements: config.replacements });
    if (turnNo <= finalTurn || !isSpeech(text)) return;
    previews.set(turnNo, text);
    typeLive(turnNo, text, pcm);
    showHeard();
  }, (err) => log(`即時預覽失敗：${err.message}`)).finally(() => { previewBusy = false; });
}

// 雲端的字回來了：這句（和更早的）預覽拿掉，換成雲端的字。回傳這是第幾句
function finishedPreview(turnNo) {
  const upTo = turnNo ?? (detector.speaking ? currentTurn - 1 : currentTurn);
  finalTurn = Math.max(finalTurn, upTo);
  for (const k of previews.keys()) if (k <= upTo) previews.delete(k);
  return upTo;
}

// 小框顯示目前聽到的：寫什麼由核心 speechBubble 決定（CubeLV 同一個）。Mac 不開 confirmedOnly：一開口就跟著出字，
// 講完比過聲紋才標「你說的」，別人講的說「別人在講話」（附上聽到的字）。ignored：剛切完的這句聲紋不像你時，本機預覽聽到的字
// 游標在框裡（寫了草稿、正在邊講邊打，或游標在框裡等著打）：已經打進框的句子不再寫一次，還沒進框的（講不到 1 秒、聲紋還沒比夠、
// 預覽還沒打上去）寫在小框，講話中一定看得到聽到的字（11/08 使用者：講到一半變成「聽著」，不知道有沒有聽到）；
// 字都在框裡就寫「邊講邊打」。游標不在框裡照舊寫這段聽到的全部
function showHeard(ignored) {
  if (state !== 'listening') return;
  const inField = drafts.typing() || (liveOn() && fieldEditable);
  const parts = inField ? [] : segmenter.parts();
  const pending = [...previews].filter(([turn]) => !(inField && drafts.shows(turn))).map(([, text]) => text);
  const shown = speechBubble({
    heard: heardText(parts),
    live: heardText(parts, pending),
    working: segmenter.working() || '',
    speaking: detector.speaking,
    // 聲紋還在背景學的時候不標是誰講的（core/voiceprint.mjs：沒有建立聲紋這一步）
    speaker: voiceprint?.enrolled() ? lastSpeaker : '',
    ignored,
  });
  if (shown) {
    const text = shown.state === 'working' && inField ? '' : shown.text;
    bubble(shown.state, { text, speaker: shown.speaker, typing: inField && !text && drafts.shows(currentTurn) });
  }
  else if (!outputQueue.length && !outputBusy) bubble('hide');
}

// 停麥克風時把講到一半的那句送出去
function finishTurn() {
  if (carry.length >= 2) takeBatch(Buffer.from(carry.subarray(0, carry.length - (carry.length % 2))));
  carry = Buffer.alloc(0);
  const { audio, turn } = splitter.finish();
  if (turn) {
    log(`麥克風停了，講到一半的那句（${((turn.endMs - turn.startMs) / 1000).toFixed(1)} 秒）送去轉寫`);
    takeAudio(audio);
    queueTurn();
  }
  turnAudio = [];
  turnAudioBytes = 0;
  turnPeak = 0;
  pendingChunks = [];
  pendingBytes = 0;
}

let captureEnded = null;
let captureName = 'ffmpeg'; // 現在用哪個收音（原生收音／ffmpeg），記 log 用
// 麥克風卡住：ffmpeg 還活著但不再送聲音（電腦睡醒、麥克風裝置換了之後會這樣，10/19 卡了 4 小時才發現）。
// 開著麥克風卻 8 秒都沒有聲音進來（安靜也會一直送 0），就重開。不用更短：電腦很忙時（11/08 記憶體用完）收音小幫手、
// 這支程式自己會停 3～8 秒，聲音晚到但麥克風沒壞，重開反而把講到一半的句子切斷、再掉一兩秒聲音（11/08 一分鐘內誤重開三次）。
// 這支程式自己剛卡住過（每 0.25 秒的心跳隔了超過 1 秒）也先不算：卡住時積著的聲音還沒讀進來
const CAPTURE_STALL_MS = 8000;
let lastAudioAt = 0;
let loopBeatAt = Date.now();
let loopStalledAt = 0;
setInterval(() => {
  const now = Date.now();
  if (now - loopBeatAt > 1000) loopStalledAt = now;
  loopBeatAt = now;
}, 250).unref();
// 收音程式的警告：同一句一分鐘最多記一次，附上這段時間出現幾次
const ffmpegNotes = new Map(); // 去掉數字的那句 → { at, count }
function logFfmpeg(line, name) {
  const key = line.replace(/[0-9.]+/g, '#').slice(0, 120);
  const note = ffmpegNotes.get(key) ?? { at: 0, count: 0 };
  note.count += 1;
  if (Date.now() - note.at >= 60_000) {
    log(`${name}：${line.trim().slice(0, 200)}${note.count > 1 ? `（一分鐘內 ${note.count} 次）` : ''}`);
    note.at = Date.now();
    note.count = 0;
  }
  ffmpegNotes.set(key, note);
}

// 收麥克風用原生小幫手（bin/mic-capture.swift，AVAudioEngine）：ffmpeg 的 avfoundation 會掉約一成聲音
// （10/25 實測 20 秒只交出 17.9 秒，小幫手 20.0 秒），講話中間少一截、句尾變「……」。
// 第一次用 swiftc 編到 <狀態資料夾>/bin/mic-capture（原始檔改了會重編）；沒有 swiftc、編不過或開不起來就照舊用 ffmpeg。
const MIC_HELPER_SRC = join(import.meta.dirname, 'mic-capture.swift');
const MIC_HELPER = join(STATE_DIR, 'bin', 'mic-capture');
let micHelperBroken = false; // 這次執行開不起來過：之後都用 ffmpeg
function micHelper() {
  if (micHelperBroken || process.env.VOICE_DICTATION_FFMPEG_CAPTURE) return null;
  try {
    if (existsSync(MIC_HELPER) && statSync(MIC_HELPER).mtimeMs >= statSync(MIC_HELPER_SRC).mtimeMs) return MIC_HELPER;
    log('編譯原生收音小幫手（第一次約 10 秒）');
    mkdirSync(join(STATE_DIR, 'bin'), { recursive: true });
    const tmp = `${MIC_HELPER}.${process.pid}`;
    execFileSync('/usr/bin/swiftc', ['-O', MIC_HELPER_SRC, '-o', tmp], { stdio: 'ignore', timeout: 180_000 });
    renameSync(tmp, MIC_HELPER);
    return MIC_HELPER;
  } catch (err) {
    log(`原生收音小幫手編不起來，改用 ffmpeg：${err.message.split('\n')[0]}`);
    micHelperBroken = true;
    return null;
  }
}

function startCapture() {
  const helper = inputFile ? null : micHelper();
  const name = helper ? '原生收音' : 'ffmpeg';
  log(`開麥克風（${name}）`);
  levelPeak = 0;
  levelSince = Date.now();
  // 尖峰門檻用底噪的 9 倍（core/turns.mjs 的 peakOverNoise）：風扇聲裡正常講話才聽得到
  splitter = new TurnSplitter({ tentativeMs: config.engine === 'openai' ? config.speed.earlyTranscribeMs : 0, peakOverNoise: MAC_PEAK_OVER_NOISE });
  detector = splitter.detector;
  carry = Buffer.alloc(0);
  const input = inputFile ? ['-re', '-i', inputFile] : ['-f', 'avfoundation', '-i', ':default'];
  const child = helper ? spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(findFfmpeg(), [
    '-hide_banner', '-loglevel', inputFile ? 'error' : 'warning', '-nostdin', ...input,
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  captureName = name;
  ffmpeg = child;
  let errText = '';
  let gotAudio = false;
  child.stderr.on('data', (d) => {
    errText = (errText + d.toString()).slice(-400);
    for (const line of d.toString().split('\n').filter(Boolean)) logFfmpeg(line, name);
  });
  lastAudioAt = Date.now() + 5000; // 剛開的麥克風要一兩秒才有聲音：多等 5 秒
  child.stdout.on('data', (data) => {
    if (ffmpeg !== child) return;
    gotAudio = true;
    lastAudioAt = Date.now();
    receivedBytes += data.length;
    carry = carry.length ? Buffer.concat([carry, data]) : data;
    while (carry.length >= BATCH_BYTES) {
      takeBatch(Buffer.from(carry.subarray(0, BATCH_BYTES)));
      carry = carry.subarray(BATCH_BYTES);
    }
  });
  captureEnded = new Promise((resolve) => child.on('close', resolve));
  child.on('close', (code) => {
    if (ffmpeg !== child) return;
    ffmpeg = null;
    finishTurn();
    if (inputFile) return;
    const detail = errText.trim().split('\n').at(-1) || `${name}結束（${code}）`;
    // 小幫手：麥克風裝置換了會自己結束（code 0），馬上重開；一點聲音都沒交出來就是開不起來，改用 ffmpeg
    if (helper && gotAudio && code === 0) { captureRetryAt = Date.now() + 300; return; }
    if (helper && !gotAudio) {
      log(`原生收音開不起來，改用 ffmpeg：${detail}`);
      micHelperBroken = true;
      captureRetryAt = Date.now() + 300;
      return;
    }
    setError(gotAudio ? `麥克風中斷：${detail}` : `麥克風開不起來：${detail}`);
    captureRetryAt = Date.now() + 10_000;
  });
  child.on('error', (err) => {
    if (ffmpeg !== child) return;
    ffmpeg = null;
    if (helper) {
      log(`原生收音開不起來，改用 ffmpeg：${err.message}`);
      micHelperBroken = true;
      captureRetryAt = Date.now() + 300;
      return;
    }
    setError(`ffmpeg 開不起來：${err.message}（brew install ffmpeg）`);
    captureRetryAt = Date.now() + 30_000;
  });
}

function stopCapture() {
  const child = ffmpeg;
  ffmpeg = null;
  try { child?.kill('SIGKILL'); } catch { /* 已經結束 */ }
  finishTurn();
  audioDebug.flush();
}

// ---- 第二層：一段話（幾句）講完才整理（規則在核心 core/segment.mjs，CubeLV 的一直聽同一份）----
// 每句都轉完、而且停了 ai.segmentPauseMs 才算一段講完；提早整理（speed.pasteAfterMs）：每句都轉完、沒在講話就先整理這段，
// 整理好時已經停了 pasteAfterMs 就算講完、直接貼；又開口或又多一句就作廢，等整段講完一起整理（跟原本一樣）

const segmenter = createSegmenter({
  pauseMs: () => config.ai.segmentPauseMs,
  pasteAfterMs: () => config.speed.pasteAfterMs,
  maxChars: MAX_SEGMENT_CHARS,
  state: () => ({ speaking: detector.speaking, starting: detector.starting, busy: !!engine?.busy() || pendingBytes > 0 || drafts.busy(), lastVoiceAt }),
  prepare: (raw, signal) => {
    const draft = drafts.current();
    return frontNow().then((front) => prepare(raw, front, signal, draft));
  },
  onWorking: (raw) => bubble('working', { text: drafts.current() ? '' : raw }),
  onSegment: ({ raw, heard, prepared, earlyPolish }) => enqueueOutput({ kind: 'segment', raw, heard, prepared, earlyPolish, draft: drafts.close() }),
  log,
});

// 轉好一句：接進草稿（speed.draft，規則在核心 core/draft.mjs；框裡已經有這句的預覽就留著，整理好一次換掉），再併進這一段。
// 這段前面的字已經不再改（送出了、自己改了、游標移走了）：那些字不算這段，從這句重新開始；這句也已經送出就不算
async function addSentence(text, heard, turn) {
  if (config.speed.draft) {
    const { written, restart, dropped, stale, kept } = await drafts.add(text, turn);
    if (kept !== undefined) log(`這句留著預覽，整理好再換：${kept}（準的字：${text}；講話中先打了 ${liveWrites} 次）`);
    else if (written) log(`這句進框：${text}${liveWrites ? `（講話中先打了 ${liveWrites} 次）` : ''}`);
    liveWrites = 0;
    if (restart) segmenter.clear();
    if (stale) segmenter.add(stale, heard);
    if (dropped) {
      writeLast(text);
      log(`這句已經送出或改過（框裡是邊講邊打的字），準的字不寫，放在「複製上一句」：${text}`);
      showHeard();
      segmenter.check();
      return;
    }
  }
  segmenter.add(text, heard);
  showHeard();
  segmenter.check(); // 字一回來就看能不能提早整理，不等下一輪
}

// 辨識中（選單列的循環箭頭在轉）：有句子在轉寫、一段還在等整理、或整理好還沒寫進去
let working = false;
function updateWorking() {
  const now = !!(engine?.busy() || drafts.busy() || segmenter.has() || outputQueue.length || outputBusy);
  if (now === working) return;
  working = now;
  hudWrite(now ? 'working' : 'idle');
}

// ---- 寫進輸入框 ----

const ax = createAx({ log });
const outputQueue = [];
let outputBusy = false;
let askedAccessibility = false;
let lastInserted = null; // { pid, text：實際貼上的字, raw：原稿, ai：是不是 AI 整理過 }
const rememberedTargets = new Map(); // `${pid}:${視窗標題}` → 上次寫進去的輸入框
// 字先進輸入框：邊講邊打、整理好一次換掉（規則在核心 core/draft.mjs），這裡接 AX 小幫手
let liveWrites = 0; // 這句講話中打進框幾次（記 log 用）
const drafts = createDraftWriter({
  commands: () => commandsOn(),
  log,
  rewrite: async ({ expect, same, text, where, why }) => {
    if (dryPaste) {
      if (why === 'sentence') emit({ type: 'draft', text, dry: true });
      return { ok: true, before: '', where: { pid: 0, handle: 0 } };
    }
    const front = where ? null : await frontNow();
    const pid = where?.pid ?? front.pid;
    if (!pid || (front && !always && !allowed(front.bundle))) return { ok: false, reason: 'no-app' };
    // 寫準的字、整理後的字時，游標跑到按鈕這類地方就寫回原本那個框（跟貼上找不到框時自動對焦一樣）；講話中的預覽不搶焦點
    const written = await axCall('rewrite', {
      pid, expect, same, text, chars: config.ai.contextChars, handle: where?.handle ?? 0, refocus: why !== 'preview' && !!config.autoFocus,
    }, 6000);
    if (written?.result !== 'ok') {
      if (why === 'sentence') log(`這句沒有先寫進框：${written?.result ?? '小幫手沒回'}`);
      if (why === 'preview' && !expect) fieldEditable = false; // 游標其實不在框裡（或寫不進去）：小框改寫聽到的字
      return { ok: false, reason: written?.result ?? 'no-reply', before: written?.before ?? '', idle: written?.idle };
    }
    if (why === 'sentence') {
      hudWrite('pasted');
      emit({ type: 'draft', text });
    } else if (why === 'preview') {
      liveWrites += 1;
      emit({ type: 'live', text });
    }
    return { ok: true, before: written.before ?? '', where: { pid, handle: written.handle } };
  },
});
const vocab = createVocabAuto({
  log,
  settings: () => ({ ...config.ai.autoVocabulary, vocabularyFile: config.openai.vocabularyFile, ai: aiReady() ? aiSettings() : null }),
});
const learner = createLearner({
  ax,
  log,
  settings: () => ({ enabled: aiReady() && config.ai.learn, ai: aiSettings(), vocabularyFile: config.openai.vocabularyFile }),
  promote: (term, source) => vocab.promote(term, source),
});

const writeLast = (text) => { try { writeFileSync(LAST, text); } catch { /* 選單「複製上一句」拿不到而已 */ } };

function enqueueOutput(item) {
  outputQueue.push({ ...item, at: Date.now() });
  if (item.kind === 'text') writeLast(item.text);
  void drainOutput();
}

async function axCall(op, args, timeoutMs) {
  try {
    return await ax.call(op, args, timeoutMs);
  } catch (err) {
    log(`AX 小幫手 ${op} 失敗：${err.message}`);
    return null;
  }
}

const decider = createDecider(() => ({ jevKey: config.jev.apiKey, jevModel: config.jev.model, ai: aiReady() ? aiSettings() : null }));
const commandsOn = () => config.commands && aiReady();

// 第三層（輸入）：游標不在輸入框，挑視窗裡要寫的輸入框（規則在核心 core/flow.mjs 的 pickTarget：上次寫的那個或只有一個就直接用，
// 其他交給決策器挑，沒有決策器就照規則排第一的）。只挑不對焦（跟 AI 整理同時做），確定要打字才 focusField
async function pickField(pid, transcript, ctx) {
  const found = await axCall('targets', { pid });
  if (!found) return null;
  const remembered = rememberedTargets.get(`${pid}:${found.window?.title ?? ''}`);
  return pickTarget({ candidates: found.candidates, window: found.window, remembered, transcript, decider, context: { app: ctx?.app ?? '' }, log });
}

async function focusField({ choice, reason }) {
  await axCall('focus', { handle: choice.handle });
  log(`游標不在輸入框，自動對焦到「${choice.label || choice.role}」（${reason}）`);
}

// 截圖認字要「螢幕錄影」權限：沒有就提醒一次（小幫手第一次會跳系統詢問）
let warnedCapture = false;
function noteCapturePermission(source) {
  if (source !== 'no-permission' || warnedCapture) return;
  warnedCapture = true;
  log('這個 app 讀不到畫面，要截圖認字，但 JarvisVoice 還沒有「螢幕錄影」權限');
  setError('讀不到畫面的 app（例如 LINE）要截圖認字：系統設定 → 隱私權與安全性 → 螢幕錄影，打開「JarvisVoice」');
}

// AI 整理開著時連畫面上看得到的字一起讀（給 AI 判斷在討論什麼、專有名詞怎麼寫）；讀不到畫面的 app 會用截圖認字。
// screen: false 只讀游標與輸入框（對焦後重讀、開口時先拿游標位置給小框）
async function readContext(front, { screen = true } = {}) {
  if (dryPaste || !front.pid) return null;
  const ctx = await axCall('context', { pid: front.pid, chars: config.ai.contextChars, screen: screen && aiReady() ? config.ai.screenChars : 0 }, 15000);
  noteCapturePermission(ctx?.screenSource);
  noteAnchor(ctx);
  return ctx;
}

// 最前面的 app：tick 每 0.5 秒查一次，夠新就直接用（貼上時小幫手會再確認是不是在最前面）
let lastFront = null;
async function frontNow() {
  if (targetPid) return { bundle: '', pid: targetPid };
  if (always) return { bundle: '', pid: 0 };
  if (lastFront && Date.now() - lastFront.at < 700) return lastFront;
  return frontApp();
}

// 開口時就先讀上下文（截圖認字的 app 要 1 秒），講完直接用；先讀一次不含畫面的（很快，小框才知道游標在哪）。
// 貼上後游標前後的字變了就丟掉，下次開口再讀
let ctxCache = null; // { pid, at, done, promise }
async function prefetchContext() {
  if (dryPaste || (!aiReady() && !bubbleOn())) return;
  const front = await frontNow();
  if (!front.pid) return;
  if (ctxCache?.pid === front.pid && !ctxCache.done && Date.now() - ctxCache.at < 15_000) return; // 上一次還在讀
  const entry = { pid: front.pid, at: Date.now(), done: false };
  ctxCache = entry;
  const quick = aiReady() && config.ai.screenChars && bubbleOn() ? readContext(front, { screen: false }) : null;
  entry.promise = (async () => {
    await quick;
    return readContext(front);
  })().finally(() => { entry.done = true; });
}

function contextFor(front) {
  if (ctxCache?.pid === front.pid && Date.now() - ctxCache.at < 60_000) return ctxCache.promise;
  return readContext(front);
}

// 講話中先把要用到的連線接好（每個網址 3 秒最多一次，雙發要幾條就接幾條）：HEAD 一下，連線留在連線池，
// 講完的請求不用重新握手（實測冷的多 0.05～0.12 秒）。只在選單列小程式裡做（測試的假伺服器不用）
const warmedAt = new Map();
function warmUp() {
  if (!config.speed.warm || !(appMode || process.env.VOICE_DICTATION_WARM)) return;
  const urls = [];
  if (config.engine === 'openai' && !isLiveModel(config.openai.model)) urls.push(process.env.VOICE_DICTATION_OPENAI_HTTP_URL || 'https://api.openai.com/v1/audio/transcriptions');
  if (aiReady() && config.ai.provider !== 'cubelv') urls.push(DEFAULT_URLS[config.ai.provider]);
  // CubeLV：轉寫與 AI 整理都在同一個網域，暖一條就好（/health 由 router 直接回，不碰後端）
  if (config.engine === 'cubelv' || (aiReady() && config.ai.provider === 'cubelv')) urls.push(`${config.cubelv.apiUrl}/health`);
  if (commandsOn() && config.jev.apiKey) urls.push(DEFAULT_URLS.jev);
  const now = Date.now();
  for (const url of urls) {
    if (now - (warmedAt.get(url) ?? 0) < 3000) continue;
    warmedAt.set(url, now);
    for (let i = 0; i < Math.max(1, config.speed.hedge); i += 1) {
      fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) }).then((r) => r.arrayBuffer()).catch(() => {});
    }
  }
}

// 整理前的準備（可以提早做，不貼、不動畫面）：上下文（開口時就先讀了）、AI 整理，游標不在輸入框時同時挑好要寫的框。
// signal：提早整理作廢時取消 AI 請求。draft：這段已經先寫進框的草稿：游標一定在框裡，游標前的字用寫草稿之前記下的，
// 不然 AI 會以為草稿本來就在框裡，把要寫的字省掉
async function prepare(raw, front, signal, draft = null) {
  const read = await contextFor(front);
  const ctx = draft ? { ...read, field: { ...read?.field, known: true, editable: true, before: draft.before, selected: '' } } : read;
  const inField = !ctx?.field.known || ctx.field.editable;
  const out = { front, ctx, inField, result: null, pick: null, aiDoneAt: 0 };
  // 不在輸入框、也沒開自動找或指令：不用送 AI
  if (!inField && !config.autoFocus && !commandsOn()) return out;
  if (!inField && config.autoFocus) {
    out.pick = pickField(front.pid, raw, ctx).catch((err) => { log(`挑輸入框失敗：${err.message}`); return null; });
  }
  out.result = await aiEdit(raw, front, ctx, signal);
  out.aiDoneAt = Date.now();
  return out;
}

// 講完到貼上的時間：講完（最後一次聽到人聲）→ 字回來 → 整理好 → 貼上
function speedNote(item, prep, pasteStartAt, pastedAt) {
  const end = item.heard?.voiceEndAt;
  if (!end) return null;
  const s = (ms) => (ms / 1000).toFixed(2);
  const parts = {
    total: pastedAt - end,
    heard: item.heard.heardAt - end,
    transcribeMs: item.heard.ms ?? null,
    earlyTranscribe: !!item.heard.early,
    aiDone: prep?.aiDoneAt ? prep.aiDoneAt - end : null,
    aiMs: prep?.result?.ms ?? null,
    earlyPolish: !!item.earlyPolish,
    paste: pastedAt - pasteStartAt,
    ...(item.draft ? { draft: item.draft.writtenAt - end } : {}),
  };
  const bits = [`字回來 ${s(parts.heard)}${parts.earlyTranscribe ? '（停 0.4 秒就先送）' : ''}`];
  if (parts.aiDone !== null) bits.push(`整理好 ${s(parts.aiDone)}（AI ${s(parts.aiMs ?? 0)}${parts.earlyPolish ? '，字一回來就整理' : ''}）`);
  bits.push(`${item.draft ? '換字' : '貼上'} ${s(parts.paste)}`);
  const head = item.draft ? `講完到草稿 ${s(parts.draft)} 秒，到換成整理後的字 ${s(parts.total)} 秒` : `講完到貼上 ${s(parts.total)} 秒`;
  return { parts, line: `速度：${head}（${bits.join('、')}）` };
}

// AI 整理＋是不是指令：規則在核心（core/flow.mjs 的 judgeUtterance，CubeLV 同一份），這裡接 Mac 的 AI、Jev 與輔助使用。
// 有 Jev 才另外問決策器：游標在輸入框時看畫面判斷是不是要操作（judgeInField），不在輸入框時問是指令的機率；沒有 Jev 就照 AI 整理的判斷。
// 對照：cubelv_docs/分析/2026-10-18_JarvisVoice_Jev必要性.md
async function aiEdit(raw, front, ctx, signal) {
  if (!aiReady()) return null;
  const inField = !!ctx?.field.editable;
  const jevOn = commandsOn() && config.jev.apiKey && front.pid;
  // 讀不到畫面的 app（例如 LINE）會用截圖認出來的字補上
  const screen = { elements: (opts) => axCall('elements', { pid: front.pid, ...opts }, 15000) };
  const judge = jevOn && inField
    ? judgeInField({ raw, screen, decider, field: ctx.field, context: { app: ctx.app ?? '', window: ctx.window ?? '' } })
      .then((v) => { noteCapturePermission(v.source); return v; }, (err) => { log(`Jev 判斷指令失敗：${err.message}`); return null; })
    : null;
  // 游標不在輸入框：同時問 Jev 是不是指令（不多花時間），只在 AI 說是打字時才用得到
  const intent = jevOn && !inField
    ? decider.decide({ transcript: raw, app: ctx?.app ?? '', window: ctx?.window ?? '', field: '' }, { intent: intentQuestion() })
      .then((a) => a.intent?.probabilities?.command ?? 0, (err) => { log(`Jev 判斷指令失敗：${err.message}`); return null; })
    : null;
  const edit = (transcript) => editSegment({
    ...aiSettings(),
    transcript,
    context: { app: ctx?.app, bundle: front.bundle, window: ctx?.window, url: ctx?.url, field: ctx?.field, screen: ctx?.screen },
    style: styleFor(config, front.bundle, ctx?.url),
    vocabulary: config.openai.keywords,
    commands: commandsOn(),
    hedge: config.speed.hedge,
    signal,
  });
  return judgeUtterance({ raw, inField, edit, judge, intent, aborted: () => !!signal?.aborted, log });
}

const openApp = (name) => new Promise((resolve) => {
  execFile('/usr/bin/open', ['-a', name], { timeout: 5000 }, (err) => resolve(!err));
});

// 第三層（指令）：交給核心的操作代理（core/agent.mjs 的 runAgent，CubeLV 同一套）：每一步讀最前面那個 app 的畫面
// （bin/agent-screen.mjs），AI 挑工具做，做到畫面就是目標。傳訊息給某人也一樣，要寫的訊息、要去的 app 放進目標裡
async function runVoiceCommand(result, raw, front, ctx) {
  const goal = [
    result.goal,
    result.app && !result.goal.includes(result.app) ? `（在 ${result.app}）` : '',
    result.message ? `（要寫的訊息：${result.message}）` : '',
  ].join('');
  log(`指令：${goal}`);
  if (dryPaste) {
    emit({ type: 'command', goal: result.goal, app: result.app, message: result.message, dry: true });
    return '';
  }
  bubble('command', { text: result.goal });
  const ai = service(aiSettings());
  let outcome;
  try {
    outcome = await runAgent({
      screen: createMacAgentScreen({ ax, frontApp, openApp, log }),
      complete: (req) => ai.complete(req),
      goal,
      said: raw,
      context: { app: ctx?.app ?? '' },
      stopped: () => existsSync(PAUSED),
      // 小框跟著顯示做到哪一步（核心 stepText：「第 1 步：點「Gmail」」）
      onStep: (step) => bubble('command', { text: result.goal, detail: stepText(step, ZH ? 'zh' : 'en') }),
      log,
    });
  } catch (err) {
    outcome = { ok: false, reason: err.message, steps: [] };
  }
  ctxCache = null;
  const steps = outcome.steps ?? [];
  log(outcome.ok ? `指令完成${outcome.summary ? `（${outcome.summary}）` : ''}：${steps.join(' → ') || '畫面本來就是'}` : `指令沒完成：${outcome.reason}`);
  hudWrite(outcome.ok ? 'pasted' : 'nofield');
  bubble(outcome.ok ? 'done' : 'failed', { text: result.goal, detail: outcome.ok ? '' : outcome.reason });
  writeLast(raw);
  emit({ type: 'command', goal: result.goal, ok: outcome.ok, steps, reason: outcome.reason ?? '', summary: outcome.summary ?? '' });
  if (config.ai.history) {
    appendHistory({ app: ctx?.app ?? '', bundle: front.bundle, raw, mode: 'command', goal: result.goal, ok: outcome.ok, steps });
  }
  return '';
}

// 把游標前剛貼的那段換掉（換回原稿、或刪掉）
async function replaceLast(front, replacement, label) {
  if (!lastInserted || lastInserted.pid !== front.pid) {
    log(`${label}：這個 app 裡沒有剛寫進去的字`);
    return;
  }
  const r = await axCall('replace', { pid: front.pid, old: lastInserted.text, text: replacement });
  if (r?.result === 'ok') {
    log(`${label}：完成`);
    lastInserted = replacement ? { ...lastInserted, text: replacement, ai: false } : null;
    hudWrite('pasted');
    return;
  }
  writeLast(lastInserted.raw);
  hudWrite('nofield');
  log(`${label}：游標前面已經不是剛貼的字（${r?.result ?? '小幫手沒回'}），沒動；原稿放在「複製上一句」`);
}

const NOFIELD_HINT = ZH ? '點選單列的 JarvisVoice →「複製上一句」可以拿回來' : 'Get it back from JarvisVoice in the menu bar → "Copy last sentence"';

function skipNoField(raw, role) {
  writeLast(raw);
  log('游標不在輸入框，這段沒寫：', raw, `（${role}）`);
  hudWrite('nofield');
  bubble('nofield', { detail: NOFIELD_HINT });
  emit({ type: 'skipped', text: raw, reason: `not-text-field:${role}` });
  return '';
}

// 整理完不是要寫字：指令、刪掉剛剛那段、換回原文、只有語氣詞
async function actOnPlan(plan, raw, front, ctx) {
  if (plan.kind === 'command') return runVoiceCommand(plan.result, raw, front, ctx);
  if (plan.kind === 'delete_last') await replaceLast(front, '', '刪掉剛剛那段');
  else if (plan.kind === 'revert_last') {
    if (lastInserted?.ai) await replaceLast(front, withSpacing(lastInserted.raw), '換回原文');
  } else if (plan.kind === 'filler') {
    writeLast(raw);
    bubble('hide');
    log('整段只有語氣詞，不寫：', raw);
  }
  return '';
}

// 字進去了（貼上，或草稿換好）：記下來給「換回原文」、歷史、自動學詞
function noteWritten({ item, prep, ctx, front, text, raw, result, handle, startAt, doneAt, message, shown, extra = {} }) {
  ctxCache = null; // 游標前後的字變了，下次開口重讀
  const speed = speedNote(item, prep, startAt, doneAt);
  log(message);
  if (speed) log(speed.line);
  bubble(shown);
  emit({ type: 'pasted', text, raw, mode: result?.mode ?? 'insert', ...extra, ...(speed ? { latencyMs: speed.parts.total, timing: speed.parts } : {}) });
  lastInserted = { pid: front.pid, text, raw, ai: !!result && result.text !== raw };
  if (ctx?.field.editable) rememberedTargets.set(`${front.pid}:${ctx.window}`, { role: ctx.field.role, label: ctx.field.label });
  if (config.ai.history) {
    appendHistory({
      app: ctx?.app ?? '', bundle: front.bundle, raw, text: result ? result.text : raw, mode: result?.mode ?? 'insert',
      ai: result ? `${config.ai.provider}/${result.model}` : '', ms: result?.ms ?? 0,
      ...(speed ? { latencyMs: speed.parts.total } : {}), ...(speed?.parts.draft !== undefined ? { draftMs: speed.parts.draft } : {}),
    });
  }
  // 詞彙表自動更新：記下用到的自動詞，不太頻繁地從畫面挑新的專有名詞
  if (aiReady()) void vocab.afterSegment({ screen: ctx?.screen ?? '', text: result ? result.text : raw });
  // AI 整理後貼的，盯一下使用者有沒有自己改專有名詞
  if (result?.mode === 'insert' && handle && ctx?.field && !ctx.field.selected) {
    learner.watch({ handle, inserted: text, before: ctx.field.before ?? '', after: ctx.field.after ?? '' });
  }
}

// 這段已經先寫了草稿：AI 整理好把它換掉。已經送出、自己改過、游標移走、換了 app 就不動（核心 core/draft.mjs）
async function deliverDraft(item, front) {
  const { raw, draft } = item;
  if (draft.gone || (!dryPaste && front.pid !== draft.where.pid)) {
    drafts.forget(draft);
    writeLast(raw);
    log(`草稿已經送出、改過或換了 app，不換：${draft.text}`);
    bubble('hide');
    return '';
  }
  if (!item.prepared) {
    bubble('working');
    item.prepared = prepare(raw, front, undefined, draft);
  }
  const prep = await item.prepared;
  const ctx = prep?.ctx ?? null;
  const plan = planOutput({ raw, result: prep?.result ?? null });
  if (plan.failed) {
    log(`AI 整理失敗，留原稿：${plan.failed}`);
    lastError = { message: plan.failed, at: Date.now() };
  }
  if (plan.kind !== 'write') {
    // 不是要打的字：先把草稿拿掉。拿不掉＝已經送出或改過，那就是要打的字，不照指令做
    const removed = await drafts.settle(draft, '');
    if (removed === 'ok') return actOnPlan(plan, raw, front, ctx);
    writeLast(raw);
    log(`草稿已經送出或改過（${removed}），不照「${plan.kind}」做：${raw}`);
    bubble('hide');
    return '';
  }
  const result = plan.result ?? null;
  // 沒有整理的結果（失敗、Jev 說不是指令）：換成原稿（框裡留著預覽的句子換成準的字；本來就是原稿就不用換）
  const text = result ? withSpacing(plan.text) : draft.raw;
  writeLast(plan.text);
  const startAt = Date.now();
  const outcome = await drafts.settle(draft, text);
  const doneAt = Date.now();
  if (outcome !== 'ok' && outcome !== 'same') {
    ctxCache = null;
    log(`草稿已經送出或改過（${outcome}），不換：${text}`);
    bubble('hide');
    emit({ type: 'kept', text: draft.text, raw, polished: text, reason: outcome });
    lastInserted = { pid: draft.where.pid, text: draft.text, raw, ai: false };
    if (config.ai.history) {
      appendHistory({ app: ctx?.app ?? '', bundle: front.bundle, raw, text: draft.text, polished: plan.text, kept: true, mode: result?.mode ?? 'insert', ai: result ? `${config.ai.provider}/${result.model}` : '', ms: result?.ms ?? 0 });
    }
    return '';
  }
  const replaced = outcome === 'ok';
  if (dryPaste) {
    const speed = speedNote(item, prep, startAt, doneAt);
    if (speed) log(speed.line);
    emit({ type: 'pasted', text, raw, mode: plan.mode, dry: true, replaced, ...(speed ? { latencyMs: speed.parts.total, timing: speed.parts } : {}) });
    return '';
  }
  noteWritten({
    item, prep, ctx, front, text, raw, result, handle: draft.where.handle, startAt, doneAt,
    message: replaced ? `已換成整理後的字：${text}` : `整理後字一樣，不用換：${text}`,
    shown: replaced ? 'polished' : 'hide',
    extra: { replaced },
  });
  return '';
}

// 回傳 'retry' 表示現在寫不進去（沒權限、前景換了），放回佇列等一下
async function deliver(item, front) {
  if (item.kind === 'revert') {
    if (lastInserted?.ai) await replaceLast(front, withSpacing(lastInserted.raw), '換回原文');
    else log('換回原文：上一段沒有經過 AI 整理');
    return '';
  }
  if (item.draft) return deliverDraft(item, front);
  const raw = item.kind === 'segment' ? item.raw : item.text;
  // 一段：提早整理好的（或上次整理好、只是當時寫不進去的）直接用，不再問一次 AI
  if (item.kind === 'segment' && !item.prepared) {
    bubble('working', { text: raw });
    item.prepared = prepare(raw, front);
  }
  const prep = item.kind === 'segment' ? await item.prepared : null;
  let ctx;
  let inField;
  let pick = null;
  if (prep && prep.front.pid === front.pid) ({ ctx, inField, pick } = prep);
  else {
    // 一句一句貼（AI 關著），或整理時跟現在最前面的不是同一個 app：照現在的 app 讀
    ctx = await contextFor(front);
    inField = !ctx?.field.known || ctx.field.editable;
  }
  // 不在輸入框、也沒開自動找或指令：不用送 AI
  if (!inField && !config.autoFocus && !commandsOn()) return skipNoField(raw, ctx.field.role);
  // 整理完要做什麼：規則在核心（core/flow.mjs 的 planOutput），整理失敗照原稿寫
  const plan = planOutput({ raw, result: prep?.result ?? null });
  if (plan.failed) {
    log(`AI 整理失敗，改貼原稿：${plan.failed}`);
    lastError = { message: plan.failed, at: Date.now() };
  }
  if (plan.kind !== 'write') return actOnPlan(plan, raw, front, ctx);
  const result = plan.result ?? null;
  if (!inField) {
    const chosen = config.autoFocus ? await (pick ?? pickField(front.pid, plan.text, ctx)) : null;
    if (!chosen) return skipNoField(raw, ctx.field.role);
    await focusField(chosen);
    ctx = await readContext(front, { screen: false });
  }
  const text = withSpacing(plan.text);
  writeLast(plan.text);
  if (dryPaste) {
    const speed = speedNote(item, prep, Date.now(), Date.now());
    if (speed) log(speed.line);
    emit({ type: 'pasted', text, raw, mode: plan.mode, dry: true, ...(speed ? { latencyMs: speed.parts.total, timing: speed.parts } : {}) });
    return '';
  }
  const pasteStartAt = Date.now();
  let pasted = await axCall('paste', { pid: front.pid, text, ask: !askedAccessibility }, 6000);
  // 要貼的時候游標已經不在輸入框（開口時在框裡，講完前點到按鈕、區塊，或焦點被 app 移走）：跟開口時就不在框裡一樣，
  // 自動挑視窗裡的輸入框對焦再貼，不丟掉這段（10/25 兩段長話因為焦點在 AXGroup、AXPopUpButton 整段沒寫）
  if (pasted?.result?.startsWith('not-text-field') && config.autoFocus) {
    log(`要貼的時候游標不在輸入框（${pasted.result.slice(15)}），自動找輸入框`);
    const chosen = await pickField(front.pid, plan.text, ctx);
    if (chosen) {
      await focusField(chosen);
      ctx = await readContext(front, { screen: false });
      pasted = await axCall('paste', { pid: front.pid, text, ask: !askedAccessibility }, 6000);
    }
  }
  const pastedAt = Date.now();
  if (pasted?.result === 'no-accessibility') {
    if (!askedAccessibility) log('貼不進去：「JarvisVoice」還沒有輔助使用權限，開了就會補貼：', text);
    askedAccessibility = true;
    setError('沒有「輔助使用」權限，字貼不進去：系統設定 → 隱私權與安全性 → 輔助使用，打開「JarvisVoice」');
    return 'retry';
  }
  if (pasted?.result === 'not-front') {
    if (!item.notFront) log('要寫的時候最前面換了 app，等它回到最前面再寫');
    item.notFront = true;
    return 'retry';
  }
  if (pasted?.result?.startsWith('not-text-field')) {
    log('游標不在輸入框，視窗裡也找不到輸入框，這段沒寫（放在「複製上一句」）：', text, `（${pasted.result.slice(15)}）`);
    hudWrite('nofield');
    bubble('nofield', { detail: NOFIELD_HINT });
    emit({ type: 'skipped', text, reason: pasted.result });
    return '';
  }
  if (pasted?.result !== 'ok') {
    log('貼上沒成功：', pasted?.result ?? '（小幫手沒回應）');
    return '';
  }
  hudWrite('pasted');
  noteWritten({ item, prep, ctx, front, text, raw, result, handle: pasted.handle, startAt: pasteStartAt, doneAt: pastedAt, message: `已貼上：${text}`, shown: 'pasted' });
  return '';
}

async function drainOutput() {
  if (outputBusy) return;
  outputBusy = true;
  try {
    while (outputQueue.length) {
      const item = outputQueue[0];
      if (Date.now() - item.at > HOLD_MS) {
        outputQueue.shift();
        if (item.draft) drafts.forget(item.draft);
        log('一分鐘內都寫不進去（前景是不收音的 app，或沒有輔助使用權限），丟掉一段：', item.text ?? item.raw ?? '');
        continue;
      }
      const front = targetPid ? { bundle: '', pid: targetPid } : always ? { bundle: '', pid: 0 } : await frontApp();
      if (!always && !allowed(front.bundle)) break;
      outputQueue.shift();
      let outcome = '';
      try {
        outcome = await deliver(item, front);
      } catch (err) {
        log(`寫入出錯：${err?.stack || err}`);
      }
      if (outcome === 'retry') { outputQueue.unshift(item); break; }
    }
  } finally {
    outputBusy = false;
  }
}

// ---- 主迴圈 ----

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  stopCapture();
  engine?.close();
  ax.close();
  releaseLock();
  setState('off');
  process.stdout.write('', () => process.exit(code));
}

async function tick() {
  if (stopping) return;
  reloadConfigIfChanged();
  const paused = existsSync(PAUSED);
  if (appMode && process.ppid !== parentPid) { shutdown(0); return; } // 選單列小程式不在了
  const front = always ? { bundle: 'test', pid: 0 } : await frontApp();
  if (!always) lastFront = { ...front, at: Date.now() };
  const active = !paused && (always || allowed(front.bundle));
  frontActive = active;

  if (reopenCapture && ffmpeg && !inputFile) { reopenCapture = false; stopCapture(); }
  if (ffmpeg && !inputFile && Date.now() - lastAudioAt > CAPTURE_STALL_MS && Date.now() - loopStalledAt > CAPTURE_STALL_MS / 2) {
    log(`麥克風 ${((Date.now() - lastAudioAt) / 1000).toFixed(1)} 秒沒有聲音進來（${captureName}卡住，多半是電腦睡醒或換了麥克風），重開麥克風`);
    stopCapture();
  }
  if (active && !ffmpeg && !inputFile && Date.now() >= captureRetryAt) startCapture();
  if (!active && ffmpeg && !inputFile) stopCapture();
  if (!active && segmenter.has()) segmenter.force(); // 暫停或切到不收音的 app：講到一半的那段先整理

  if (existsSync(VOICEPRINT_RESET)) {
    try { unlinkSync(VOICEPRINT_RESET); } catch { /* 已經處理 */ }
    if (voiceprint) {
      voiceprint.reset();
      log('重錄聲紋：從你接下來講的話錄樣本（約 10 秒，照常轉寫）');
      lastSpeaker = '';
      announceSettings();
    }
  }

  if (existsSync(REVERT)) {
    try { unlinkSync(REVERT); } catch { /* 已經處理 */ }
    enqueueOutput({ kind: 'revert' });
  }

  stageAudio();
  engine.flush();
  engine.housekeeping({ active, quietForMs: Date.now() - lastSpeechAt, speaking: detector.speaking });
  void drainOutput();
  void learner.tick();

  if (paused) setState('paused');
  else if (!active) setState('standby');
  else if (lastError && Date.now() - lastError.at < 15_000) setState('error', lastError.message);
  else if (ffmpeg) setState('listening');
}

async function main() {
  if (!takeLock()) {
    emit({ type: 'state', state: 'already-running' });
    process.exit(3);
  }
  if (appMode) {
    try { if (statSync(LOG).size > 1_000_000) writeFileSync(LOG, ''); } catch { /* 還沒有 log */ }
    // 沒權限就在啟動時跳系統詢問，「JarvisVoice」才會出現在輔助使用清單裡
    const access = await axCall('check', { ask: true });
    if (!access?.trusted) askedAccessibility = true;
    log(`輔助使用權限：${access?.trusted ? '有' : '沒有（字貼不進去：系統設定 → 隱私權與安全性 → 輔助使用，打開「JarvisVoice」）'}`);
  }
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('exit', releaseLock);
  setState('standby');
  startEngine();
  setInterval(() => { segmenter.check(); updateWorking(); }, SEGMENT_CHECK_MS);

  if (inputFile) {
    startCapture();
    setState('listening');
    const timer = setInterval(() => { stageAudio(); engine.flush(); }, 250);
    await captureEnded;
    finishTurn();
    // 等所有句子轉完、整理完、貼完
    const until = Date.now() + 30_000;
    while (Date.now() < until && (engine.busy() || drafts.busy() || segmenter.has() || outputQueue.length || outputBusy)) {
      engine.flush();
      if (!engine.busy()) segmenter.force();
      void drainOutput(); // 寫不進去（不在最前面）的那段，等一下再試
      await new Promise((r) => setTimeout(r, 200));
    }
    clearInterval(timer);
    shutdown(0);
    return;
  }

  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  log(err?.stack || String(err));
  setError(err?.message || String(err));
  releaseLock();
  process.exit(1);
});
