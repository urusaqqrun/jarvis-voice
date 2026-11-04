// 設定：~/.voice-dictation/config.json（VOICE_DICTATION_CONFIG 可指定別的檔），沒寫的照預設。
// 自己的 key 最簡單是從選單「設定自己的 key…」貼（存在鑰匙圈，不在這個檔，見 bin/own-keys.mjs）；讀 key 時它最優先，
// 再來才是這個檔的 apiKey／keys、apiKeyFile／keyFiles、keyCommands、環境變數。
//
// {
//   "engine": "local",                 // local（本機 SenseVoice，免費）| openai（自己的 OpenAI key）| cubelv（用 CubeLV 登入，扣點數）| parallelsandbox
//   "apps": ["*"],                     // 這些 app 在最前面時才收音（bundle id）；"*" 是全部
//   "excludeApps": ["us.zoom.xos"],    // 這些 app 在最前面時不收音（開會、通話用的 app）
//   "output": "traditional",           // traditional（台灣正體）| simplified | original
//   "replacements": { "部屬": "部署" }, // 轉出來的字固定替換，給常錯的專有名詞用
//   "local": { "model": "<模型資料夾>", "language": "auto", "threads": 2 },
//   "openai": { "apiKey": "", "apiKeyFile": "", "model": "gpt-transcribe", "languages": [], "prompt": "",
//               "keywords": [], "vocabularyFile": "<狀態資料夾>/vocabulary.txt" },
//                                      // model 是 gpt-transcribe（一般，講完一句整句轉，預設）或 gpt-live-transcribe（即時）
//                                      // apiKeyFile：key 放在別的檔案時填路徑（純 key，或含 OPENAI_API_KEY= 的 .env）
//                                      // prompt：一兩句話講這是什麼場合；keywords／vocabularyFile：會講到的專有名詞，一行一個
//                                      // languages：預期的語言（例如 ["zh", "en"]）；舊的 language 單一字串也接受
//   "parallelsandbox": { "apiKey": "", "apiUrl": "https://api.parallelsandbox.com" },
//   "cubelv": { "apiUrl": "https://app-api.cubelv.com" },
//                                      // 用 CubeLV 登入（選單「用 CubeLV 登入…」）：不用 key，轉寫與 AI 整理扣 CubeLV 點數。
//                                      // token 存在鑰匙圈，不寫進這個檔；登入時記下原本的 engine 與 AI 整理（previous），登出時換回來
//   "ai": {                            // AI 整理（Typeless 的做法）：一段話講完，帶上下文交給 AI 整理再貼
//     "enabled": true,                 // 三層預設都開；沒有 AI 的 key 時只跑第一層
//     "provider": "deepseek",          // openai | deepseek | claude | cubelv（用 CubeLV 登入）；沒寫就用已經有 key 的那家（DeepSeek → Claude → OpenAI）
//     "models": {},                    // 換模型：{ "openai": "gpt-6-luna", "deepseek": "deepseek-flash", "claude": "claude-haiku-5-5" }
//     "keys": {}, "keyFiles": {},      // 各家的 key，或放 key 的檔案（純 key 或 .env）；沒寫就看環境變數，OpenAI 沿用 openai 的 key
//     "keyCommands": {},               // 或用指令拿 key，key 不落地：{ "deepseek": "aws ssm get-parameter ... --output text" }
//     "segmentPauseMs": 1800,          // 停多久算一段講完
//     "contextChars": 400,             // 游標前後各讀幾個字給 AI
//     "screenChars": 1500,             // 視窗裡看得到的字（不含輸入框）讀最後幾個字給 AI
//     "styles": {},                    // 各 app（bundle id）或網站（網域）的語氣，蓋過內建的
//     "history": true,                 // 本機歷史：<狀態資料夾>/history.jsonl
//     "learn": true,                   // 貼上後自己改了專有名詞，就自動加進詞彙檔
//     "autoVocabulary": { "enabled": true, "max": 250, "maxAuto": 80, "minSightings": 3 }
//                                      // 從畫面上的字自動挑新的專有名詞加進詞彙檔：畫面上 3 次不同時候都看到、或你講到了才加；
//                                      // 整張詞彙表最多 max 個、自動學到的最多 maxAuto 個，滿了先拿掉最少用到的自動詞
//   },
//   "autoFocus": true,                 // 第三層：游標不在輸入框時，自動挑視窗裡要寫的輸入框寫進去
//   "commands": true,                  // 第三層：講「進到台積電的個股頁」這類指令，直接操作 app（要有 AI 整理）
//   "jev": { "apiKey": "", "apiKeyFile": "", "apiKeyCommand": "", "model": "jev-latest" },
//                                      // 第三層的決策器：TypeSafe 的 Jev（快、便宜）；沒有 key 就改問 AI 整理那家
//   "speed": {                         // 講完到貼上的速度（cubelv_docs/計劃/2026-10-19_JarvisVoice語音加速規劃.md）
//     "earlyTranscribeMs": 400,        // 停多久就先把這句送去轉寫（0.85 秒才確定講完；中間又開口就作廢）；0 是不提早
//     "draft": true,                   // 字一回來就先把原稿寫進輸入框，AI 整理好再換掉（已經送出、自己改過就不換）；false 是整理好才寫
//     "pasteAfterMs": 1200,            // 字一回來就開始 AI 整理，整理好時已經停了這麼久就直接貼（不等 ai.segmentPauseMs）；0 是不提早
//     "hedge": 2,                      // 轉寫、AI 整理每次同時送幾份，誰先回用誰（砍掉偶爾特別慢的那幾次，費用跟著乘）
//     "preview": true,                 // 講話中用本機 SenseVoice 認目前這句，在游標旁的小框即時顯示（只顯示，不貼）
//     "bubble": true,                  // 游標旁的小框：聽到的字、整理中、已貼上（幾秒）、指令、出錯
//     "warm": true                     // 開口時先把轉寫、AI 的連線接好，講完不用重新握手
//   },
//   "voiceprint": {                    // 只聽我的聲音：本機聲紋（sherpa-onnx CAM++），不像你的句子不轉寫、不貼（選單可以切）
//     "enabled": false,                // 第一次開會從你接下來講的 10 秒錄樣本（照常轉寫）；選單「重錄我的聲紋」重來
//     "threshold": 0.3,                // 跟你的聲紋相似度低於這個就不要（實測別人最高 0.27）
//     "minSeconds": 1.5,               // 比這短的句子另外用 shortThreshold
//     "shortThreshold": 0.4            // 短句的門檻（咖啡店實測：你的短句 0.75 以上，別人的短句、雜音 0.20～0.31）
//   },
//   "debug": {                         // 自己 debug 用，預設關
//     "saveAudio": false               // 存音檔到 <狀態資料夾>/audio/：每一句（放行、聲紋擋掉都存，log 寫檔名）＋麥克風每分鐘一個檔
//                                      // （沒被當成講話的聲音也查得到）；句子留最近 400 個、麥克風留最近 30 分鐘
//   }
// }

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OWN_KEYS_FILE, ownKeyStore } from './own-keys.mjs';

export const STATE_DIR = process.env.VOICE_DICTATION_STATE_DIR || join(homedir(), '.voice-dictation');
export const CONFIG_PATH = process.env.VOICE_DICTATION_CONFIG || join(STATE_DIR, 'config.json');
export const DEFAULT_MODEL = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
export const ENGINES = ['local', 'openai', 'cubelv', 'parallelsandbox'];
export const AI_PROVIDERS = ['openai', 'deepseek', 'claude', 'cubelv'];
export const CUBELV_ACCOUNT = join(STATE_DIR, 'cubelv-account.json');
export const OWN_KEYS = join(STATE_DIR, OWN_KEYS_FILE); // 選單存了哪幾家的 key（不是秘密，key 在鑰匙圈）
const KEY_VARS = { openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', claude: 'ANTHROPIC_API_KEY' };

// 各類 app 的語氣：bundle id 或網域都可以當 key
const CHAT = '聊天訊息：口語、簡短自然，不用太正式';
const MAIL = 'email：完整句子、有禮貌、分段清楚';
const AI = '給 AI 或程式的指令：精準，保留技術名詞和原本的用詞，不加客套話';
const DOC = '文件：通順精簡';
export const DEFAULT_STYLES = {
  'com.tinyspeck.slackmacgap': CHAT, 'app.slack.com': CHAT, 'com.hnc.Discord': CHAT, 'discord.com': CHAT,
  'jp.naver.line.mac': CHAT, 'com.apple.MobileSMS': CHAT, 'net.whatsapp.WhatsApp': CHAT, 'web.whatsapp.com': CHAT,
  'ru.keepcoder.Telegram': CHAT, 'com.facebook.archon': CHAT, 'messenger.com': CHAT,
  'com.apple.mail': MAIL, 'com.microsoft.Outlook': MAIL, 'mail.google.com': MAIL, 'outlook.live.com': MAIL, 'outlook.office.com': MAIL,
  'com.anthropic.claudefordesktop': AI, 'claude.ai': AI, 'com.openai.chat': AI, 'chatgpt.com': AI,
  'com.todesktop.230313mzl4w4u92': AI, 'com.microsoft.VSCode': AI, 'com.apple.Terminal': AI, 'com.googlecode.iterm2': AI,
  'dev.warp.Warp-Stable': AI, 'com.mitchellh.ghostty': AI, 'github.com': AI,
  'notion.id': DOC, 'notion.so': DOC, 'com.apple.Notes': DOC, 'com.apple.iWork.Pages': DOC, 'com.microsoft.Word': DOC, 'docs.google.com': DOC,
};

export function defaults() {
  return {
    engine: 'local',
    apps: ['*'],
    // 開會、通話時講的話不該被貼出去；選單列小程式自己也排除
    excludeApps: [
      'us.zoom.xos', 'com.microsoft.teams', 'com.microsoft.teams2', 'com.apple.FaceTime',
      'Cisco-Systems.Spark', 'com.cisco.webexmeetingsapp', 'com.urusa.voice-dictation',
    ],
    output: 'traditional',
    replacements: {},
    local: { model: join(STATE_DIR, 'models', DEFAULT_MODEL), language: 'auto', threads: 2 },
    openai: {
      apiKey: '', apiKeyFile: '', model: 'gpt-transcribe', languages: [], language: '', prompt: '',
      keywords: [], vocabularyFile: join(STATE_DIR, 'vocabulary.txt'),
    },
    parallelsandbox: { apiKey: '', apiUrl: 'https://api.parallelsandbox.com' },
    cubelv: { apiUrl: 'https://app-api.cubelv.com' },
    ai: {
      enabled: true, provider: 'deepseek', models: {}, keys: {}, keyFiles: {}, keyCommands: {},
      segmentPauseMs: 1800, contextChars: 400, screenChars: 1500, timeoutMs: 6000, styles: {},
      history: true, learn: true,
      autoVocabulary: { enabled: true, max: 250, maxAuto: 80, minSightings: 3 },
    },
    autoFocus: true,
    commands: true,
    jev: { apiKey: '', apiKeyFile: '', apiKeyCommand: '', model: 'jev-latest' },
    speed: { earlyTranscribeMs: 400, draft: true, pasteAfterMs: 1200, hedge: 2, preview: true, bubble: true, warm: true },
    voiceprint: { enabled: false, threshold: 0.3, minSeconds: 1.5, shortThreshold: 0.4 },
    debug: { saveAudio: false },
  };
}

// 平行沙盒的 key 沒寫在設定檔時，借用 ~/.claude.json 裡 parallelsandbox MCP 的設定。
function parallelSandboxFromClaudeJson() {
  const files = [];
  if (process.env.CLAUDE_CONFIG_DIR) files.push(join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'));
  files.push(join(homedir(), '.claude.json'));
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const config = JSON.parse(readFileSync(file, 'utf8'));
      const servers = [config.mcpServers, ...Object.values(config.projects ?? {}).map((p) => p?.mcpServers)];
      const env = servers.find((s) => s?.parallelsandbox?.env?.PARALLELSANDBOX_API_KEY)?.parallelsandbox.env;
      if (env) return { apiKey: env.PARALLELSANDBOX_API_KEY, apiUrl: env.PARALLELSANDBOX_API_URL };
    } catch { /* 壞檔就看下一個 */ }
  }
  return {};
}

// key 放在別的檔案：整個檔案就是 key，或是 .env 裡的 OPENAI_API_KEY=（DeepSeek、Claude 是各自的變數名）
function keyFromFile(file, name = 'OPENAI_API_KEY') {
  if (!file) return '';
  try {
    const text = readFileSync(file.replace(/^~(?=\/)/, homedir()), 'utf8');
    const line = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\s]+)`, 'm'));
    if (line) return line[1];
    return /=/.test(text) ? '' : text.trim();
  } catch {
    return '';
  }
}

// 詞彙檔：一行一個詞，# 開頭是註解；OpenAI 不收含 < 或 > 的詞
export function readVocabulary(file) {
  if (!file) return [];
  try {
    return readFileSync(file.replace(/^~(?=\/)/, homedir()), 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function cleanKeywords(words) {
  const seen = new Set();
  return words
    .map((w) => String(w).replace(/[<>\r\n]/g, '').trim())
    .filter((w) => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()));
}

// 這個 app 在最前面時要不要收音
export function appAllowed(config, bundle) {
  if (!bundle || config.excludeApps.includes(bundle)) return false;
  return config.apps.includes('*') || config.apps.includes(bundle);
}

// 用指令拿 key（例如從 AWS SSM、1Password 讀），key 不寫進檔案。拿到就記著；失敗一分鐘後再試
const commandKeys = new Map();
function keyFromCommand(command) {
  if (!command) return '';
  const cached = commandKeys.get(command);
  if (cached && (cached.key || Date.now() - cached.at < 60_000)) return cached.key;
  let key = '';
  try {
    key = execSync(command, {
      encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], shell: '/bin/sh',
      env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
    }).trim();
  } catch { /* 拿不到 */ }
  commandKeys.set(command, { key, at: Date.now() });
  return key;
}

// 用 CubeLV 登入了沒（bin/cubelv.mjs 登入時寫、登出或登入失效時刪的帳號紀錄，不是秘密）：回傳 { apiUrl, email } 或 null。
// 登入的是別的 CubeLV（cubelv.apiUrl 換了）也算沒登入
export function cubelvAccount(config) {
  try {
    const account = JSON.parse(readFileSync(CUBELV_ACCOUNT, 'utf8'));
    return account?.apiUrl === config.cubelv.apiUrl ? account : null;
  } catch {
    return null;
  }
}

// 這家 AI 能不能用：CubeLV 看有沒有登入，其他看有沒有 key
export function aiAvailable(config, provider = config.ai.provider) {
  return provider === 'cubelv' ? !!cubelvAccount(config) : !!aiKey(config, provider);
}

// AI 整理用哪把 key：選單存的（鑰匙圈）→ 設定檔 keys → keyFiles → keyCommands → 環境變數；OpenAI 沿用轉寫的 key（CubeLV 不用 key）
export function aiKey(config, provider = config.ai.provider) {
  if (provider === 'cubelv') return '';
  const ai = config.ai;
  return config.ownKeys?.[provider] || ai.keys?.[provider] || keyFromFile(ai.keyFiles?.[provider], KEY_VARS[provider]) || keyFromCommand(ai.keyCommands?.[provider])
    || process.env[KEY_VARS[provider]] || (provider === 'openai' ? config.openai.apiKey : '') || '';
}

// 這個 app／網站要什麼語氣：網域比 app 優先（瀏覽器裡的 Gmail 要用 email 的語氣）
export function styleFor(config, bundle, url) {
  const styles = { ...DEFAULT_STYLES, ...config.ai.styles };
  let host = '';
  try { host = url ? new URL(url).hostname : ''; } catch { /* 不是網址 */ }
  if (host) {
    const key = Object.keys(styles).find((k) => host === k || host.endsWith(`.${k}`));
    if (key) return styles[key];
  }
  return styles[bundle] ?? '';
}

// 即時模型走 Realtime 連線，其他走一般轉寫（整句上傳）
export const isLiveModel = (model) => /live|realtime/i.test(model ?? '');

const mtime = (file) => {
  try { return statSync(file.replace(/^~(?=\/)/, homedir())).mtimeMs; } catch { return 0; }
};

// 設定檔、詞彙檔、CubeLV 登入狀態或選單存的 key 有改就換新設定
export function configMtime(config) {
  return `${mtime(CONFIG_PATH)}:${config?.openai?.vocabularyFile ? mtime(config.openai.vocabularyFile) : 0}:${mtime(CUBELV_ACCOUNT)}:${mtime(OWN_KEYS)}`;
}

// 回傳 { config, error }：設定檔壞掉時照預設跑，error 說哪裡壞。
export function loadConfig() {
  const base = defaults();
  let file = {};
  let error = '';
  if (existsSync(CONFIG_PATH)) {
    try { file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch (err) { error = `設定檔讀不懂：${err.message}`; }
  }
  const config = {
    ...base,
    ...file,
    local: { ...base.local, ...file.local },
    openai: { ...base.openai, ...file.openai },
    parallelsandbox: { ...base.parallelsandbox, ...file.parallelsandbox },
    cubelv: { ...base.cubelv, ...file.cubelv },
    replacements: { ...base.replacements, ...file.replacements },
    ai: { ...base.ai, ...file.ai, autoVocabulary: { ...base.ai.autoVocabulary, ...file.ai?.autoVocabulary } },
    jev: { ...base.jev, ...file.jev },
    speed: { ...base.speed, ...file.speed },
    voiceprint: { ...base.voiceprint, ...file.voiceprint },
    debug: { ...base.debug, ...file.debug },
  };
  if (!ENGINES.includes(config.engine)) {
    error = `engine 只能是 ${ENGINES.join('、')}，設定檔寫的是「${config.engine}」`;
    config.engine = 'local';
  }
  if (!Array.isArray(config.apps) || !config.apps.length) config.apps = base.apps;
  if (!Array.isArray(config.excludeApps)) config.excludeApps = base.excludeApps;
  // 選單「設定自己的 key…」存在鑰匙圈的 key：最優先（沒存過就是空的，照舊讀設定檔與環境變數）
  config.ownKeys = ownKeyStore(STATE_DIR).readAll();
  config.openai.apiKey = config.ownKeys.openai || config.openai.apiKey || keyFromFile(config.openai.apiKeyFile) || process.env.OPENAI_API_KEY || '';
  if (config.openai.apiKeyFile && !config.openai.apiKey) error = `讀不到 openai.apiKeyFile：${config.openai.apiKeyFile}`;
  config.openai.keywords = cleanKeywords([...(config.openai.keywords ?? []), ...readVocabulary(config.openai.vocabularyFile)]);
  const langs = Array.isArray(config.openai.languages) ? config.openai.languages : [];
  config.openai.languages = langs.length ? langs : config.openai.language ? [config.openai.language] : [];
  if (!AI_PROVIDERS.includes(config.ai.provider)) {
    error = `ai.provider 只能是 ${AI_PROVIDERS.join('、')}，設定檔寫的是「${config.ai.provider}」`;
    config.ai.provider = base.ai.provider;
  }
  for (const key of ['models', 'keys', 'keyFiles', 'keyCommands', 'styles']) if (typeof config.ai[key] !== 'object' || !config.ai[key]) config.ai[key] = {};
  config.autoFocus = config.autoFocus !== false;
  config.commands = config.commands !== false;
  // 沒指定 AI 用哪家：挑已經有 key 的
  if (!file.ai?.provider) config.ai.provider = ['deepseek', 'claude', 'openai'].find((p) => aiKey(config, p)) ?? base.ai.provider;
  config.jev.apiKey = config.ownKeys.jev || config.jev.apiKey || keyFromFile(config.jev.apiKeyFile, 'TYPESAFE_API_KEY') || keyFromCommand(config.jev.apiKeyCommand)
    || process.env.TYPESAFE_API_KEY || '';
  const ps = parallelSandboxFromClaudeJson();
  config.parallelsandbox.apiKey = config.parallelsandbox.apiKey || process.env.PARALLELSANDBOX_API_KEY || ps.apiKey || '';
  config.parallelsandbox.apiUrl = (process.env.PARALLELSANDBOX_API_URL || ps.apiUrl || config.parallelsandbox.apiUrl).replace(/\/+$/, '');
  config.cubelv.apiUrl = String(process.env.VOICE_DICTATION_CUBELV_URL || config.cubelv.apiUrl || base.cubelv.apiUrl).replace(/\/+$/, '');
  return { config, error };
}
