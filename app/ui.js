// 「JarvisVoice」選單列的介面與常駐程式管理。由 app/main.js（包進 .app 的外殼）啟動時讀進來執行，
// 所以改這個檔不用重包 app，麥克風與輔助使用權限也不用重給；改完從選單「結束」再打開 app 就生效。
// 帶起常駐程式 bin/listen.mjs（它掛了 3 秒後自己重開），狀態全顯示在選單列的圖示上。
// 圖示平常是「JarvisVoice」標誌：單循環箭頭包住三條聲波（自動＋聲音）；有事時整個換成大圖（看「選單列圖示」那段）。
// 固定寬度、不加字（加字會讓旁邊的圖示跳來跳去），顏色交給系統（範本圖，跟其他選單列圖示同色）。
// 選單可以切轉寫（本機／OpenAI／CubeLV／平行沙盒）、AI 整理（關／OpenAI／DeepSeek／Claude／CubeLV）、自動找輸入框、語音指令，
// 改的是設定檔，常駐程式會自己換；「設定自己的 key…」選一家、在對話框貼 key，帶起 bin/set-key.mjs 先測一次、通了才存進鑰匙圈；
// 「用 CubeLV 登入…」帶起 bin/cubelv-login.mjs（瀏覽器登入，不用 key、扣 CubeLV 點數），跟自己的 key、本機辨識並列，不是預設；
// 「換回原文」把上一段 AI 整理過的字換回轉寫原稿。
// 游標旁的小框（bubble 事件）：講話中即時顯示聽到的字、整理中、已貼上、指令做到哪一步、出錯，不搶焦點、滑鼠點不到。
// BUILD（{ node, repo, state }）由外殼放在全域。
const LISTEN = `${BUILD.repo}/bin/listen.mjs`;
const LOGIN = `${BUILD.repo}/bin/cubelv-login.mjs`;
const SET_KEY = `${BUILD.repo}/bin/set-key.mjs`;
const NODE_DIR = BUILD.node.replace(/\/[^/]*$/, '');
// 系統語言是中文就顯示中文，其他都用英文（VOICE_DICTATION_LANG 可以指定，測試用）
const LANG = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('VOICE_DICTATION_LANG'))
  || ObjC.unwrap($.NSLocale.preferredLanguages.firstObject) || '';
const ZH = /^zh/i.test(LANG);
const t = (zh, en) => (ZH ? zh : en);
const ENGINE_NAMES = { local: t('本機', 'on-device'), openai: 'OpenAI', cubelv: 'CubeLV', parallelsandbox: t('平行沙盒', 'ParallelSandbox') };
// 轉寫子選單：免費的本機排第一，CubeLV 跟自己的 key 並列
const ENGINE_ITEMS = {
  local: t('本機（免費，聲音不離開電腦）', 'On-device (free, audio stays on your Mac)'),
  openai: t('OpenAI（自己的 key）', 'OpenAI (your own key)'),
  cubelv: t('CubeLV（扣 CubeLV 點數，不用 key）', 'CubeLV (uses CubeLV credits, no key)'),
  parallelsandbox: t('平行沙盒', 'ParallelSandbox'),
};
const GUIDE_URL = 'https://github.com/urusaqqrun/jarvis-voice#readme';
const AI_NAMES = { openai: 'OpenAI', deepseek: 'DeepSeek', claude: 'Claude', cubelv: 'CubeLV' };
// 「設定自己的 key…」可以設定的幾家：用在哪、去哪裡建立、key 長什麼樣（id 跟 bin/own-keys.mjs 一樣）
const KEY_PROVIDERS = {
  openai: {
    name: 'OpenAI', use: t('轉寫與 AI 整理', 'transcription and AI cleanup'), where: 'https://platform.openai.com/api-keys', hint: 'sk-…',
    about: t('同一把 key 用在轉寫與 AI 整理。OpenAI 轉寫比本機辨識準，照錄音分鐘計費；不勾下面的選項，轉寫就維持現在的設定。',
      'One key covers transcription and AI cleanup. OpenAI transcription is more accurate than on-device and is billed per recorded minute; leave the box below unchecked to keep your current transcription.'),
  },
  deepseek: {
    name: 'DeepSeek', use: t('AI 整理', 'AI cleanup'), where: 'https://platform.deepseek.com/api_keys', hint: 'sk-…',
    about: t('用在 AI 整理（最快）。要先在 DeepSeek 儲值。', 'Used for AI cleanup (the fastest). Top up your DeepSeek account first.'),
  },
  claude: {
    name: 'Claude', use: t('AI 整理', 'AI cleanup'), where: 'https://console.anthropic.com/settings/keys', hint: 'sk-ant-…',
    about: t('用在 AI 整理。', 'Used for AI cleanup.'),
  },
  jev: {
    name: 'TypeSafe Jev', use: t('語音指令判斷，選用', 'voice-command decisions, optional'), where: 'https://typesafe.ai', hint: '',
    about: t('選用：自動找輸入框與語音指令的判斷，一步約 0.2 秒；沒有也能用（改問 AI 整理那家，一步約 1 秒）。',
      'Optional: decides auto-focus and voice commands in about 0.2 s per step; without it, your AI cleanup provider decides (about 1 s per step).'),
  },
};

let statusItem = null;
let statusLine = null;
let toggleItem = null;
let controller = null;
let task = null;
let quitting = false;
let buffer = '';
let view = { state: 'starting', message: '', engine: '' };
let hearing = false; // 常駐程式說聽到人聲
let working = false; // 常駐程式說有句子在轉寫、整理或等著寫（辨識中）
let level = 0; // 說話中的音量 0–1（常駐程式每 0.1 秒送一次）
let levelAt = 0;
let animTimer = null; // 說話中、辨識中時每 0.1 秒換一張圖
let flash = null; // { kind: 'pasted' | 'nofield', until }：短暫顯示的結果
// 常駐程式報上來的設定（settings 事件）
let settings = {
  engine: '', ai: { enabled: false, provider: 'deepseek', ready: false }, autoFocus: false, commands: false, decider: '',
  cubelv: { loggedIn: false, email: '' },
  voiceprint: { enabled: false, ready: false, enrolled: false },
};
let voiceprintItem = null;
let voiceprintResetItem = null;
let engineMenuItem = null;
const engineItems = {};
let cubelvItem = null;
let loginTask = null; // 正在跑的 bin/cubelv-login.mjs
let loginKind = ''; // in（登入中）| out（登出中）
let loginBuffer = '';
let keysItem = null;
let keyTask = null; // 正在跑的 bin/set-key.mjs
let keyKind = ''; // set（測試中）| clear（清除中）
let keyProvider = '';
let keyBuffer = '';
let keyResult = null; // set-key.mjs 最後報的結果（saved／cleared／error），程式結束時才跳對話框
let keyParts = { out: false, task: false }; // 輸出讀完了沒、程式結束了沒：兩個都到才跳結果（結束的通知可能比最後一行輸出先到）
let aiMenuItem = null;
let aiOffItem = null;
const aiItems = {};
let autoFocusItem = null;
let commandsItem = null;

const statePath = (name) => `${BUILD.state}/${name}`;
const fm = () => $.NSFileManager.defaultManager;

function label() {
  const name = ENGINE_NAMES[view.engine] ? t(`（${ENGINE_NAMES[view.engine]}）`, ` (${ENGINE_NAMES[view.engine]})`) : '';
  switch (view.state) {
    case 'listening': return settings.ai.enabled && settings.ai.ready
      ? (settings.draft
        ? t(`聽著${name}：字先進輸入框，${AI_NAMES[settings.ai.provider]} 整理好再換掉`, `Listening${name}: text goes in right away, then ${AI_NAMES[settings.ai.provider]} cleans it up`)
        : t(`聽著${name}：講完一段，${AI_NAMES[settings.ai.provider]} 整理後寫進輸入框`, `Listening${name}: each passage is cleaned up by ${AI_NAMES[settings.ai.provider]} and typed in`))
      : t(`聽著${name}：講完一句就貼進游標所在的輸入框`, `Listening${name}: each sentence is pasted where your cursor is`);
    case 'standby': return t(`待命${name}：最前面的 app 不收音`, `Standing by${name}: the frontmost app is excluded`);
    case 'paused': return t(`已暫停${name}`, `Paused${name}`);
    case 'error': return t(`出錯：${view.message}`, `Error: ${view.message}`);
    case 'already-running': return t('已經有另一個 JarvisVoice 在跑，等它結束後接手', 'Another JarvisVoice is running; taking over when it exits');
    case 'off': return t('常駐程式沒在跑，重新啟動中…', 'The background process stopped; restarting…');
    default: return t('啟動中…', 'Starting…');
  }
}

// ── 選單列圖示：20×18 點的格子（左下角原點），黑色加透明度畫，系統再依選單列換成白或黑 ──
// 平常（收音中）是 JarvisVoice 標誌：循環箭頭包住三條聲波。有事時整個換成 16 點高的大圖，一眼看得出狀況：
//   說話中＝五條聲波跟著音量動、辨識中＝標誌的循環箭頭在轉（停下到貼上：轉寫＋AI 整理）、已貼上＝打勾、
//   沒貼上＝叉叉（游標不在輸入框）、出錯＝三角形驚嘆號、待命＝標誌變淡（最前面的 app 不收音）、暫停＝標誌加一條斜線。
// 設計稿：https://claude.ai/artifact/4JHjaYSLyB8ptFdb52vYDQ
const ICON_W = 20;
const ICON_H = 18;
const QUIET = [3, 5, 8, 5, 3]; // 五條聲波最矮的樣子：說話中至少這麼高
const BAR_X = [2, 6, 10, 14, 18];
const BAR_WEIGHT = [0.62, 0.86, 1, 0.86, 0.62];

function iconPath(points) {
  const p = $.NSBezierPath.bezierPath;
  points.forEach(([x, y], i) => (i ? p.lineToPoint($.NSMakePoint(x, y)) : p.moveToPoint($.NSMakePoint(x, y))));
  return p;
}

function iconRect(x, y, w, h, alpha = 1) {
  $.NSColor.colorWithWhiteAlpha(0, alpha).set;
  const r = Math.min(w, h) / 2;
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(x, y, w, h), r, r).fill;
}

function iconStroke(points, width = 1.5) {
  $.NSColor.blackColor.set;
  const p = iconPath(points);
  p.setLineWidth(width);
  p.setLineCapStyle(1); // 圓頭
  p.setLineJoinStyle(1);
  p.stroke;
}

// 之後畫的東西改成挖空（透明），畫完 fn 再換回來
function clearing(fn) {
  const ctx = $.NSGraphicsContext.currentContext;
  ctx.setCompositingOperation(0); // NSCompositingOperationClear
  fn();
  ctx.setCompositingOperation(2); // NSCompositingOperationSourceOver
}

// 整組先畫在一張不透明的小圖上，再用 alpha 貼上來：箭頭跟圓線重疊的地方才不會比較深
function withAlpha(alpha, fn) {
  if (alpha >= 1) { fn(); return; }
  const layer = $.NSImage.alloc.initWithSize($.NSMakeSize(ICON_W, ICON_H));
  layer.lockFocus;
  fn();
  layer.unlockFocus;
  layer.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, ICON_W, ICON_H), $.NSZeroRect, 2, alpha);
}

// JarvisVoice 標誌：圓心 (10, 9)、半徑 7.5，缺口在右上。箭頭底邊中點在 50°、尖端落在圓上 84°，
// 圓線從 54°（藏在箭頭裡）順時針畫到 102°，跟箭頭尖端留一段空隙。spin 是整圈轉的角度（逆時針，跟箭頭同方向）
function drawBrand({ bars = true, spin = 0 } = {}) {
  const R = 7.5;
  const cx = 10;
  const cy = 9;
  $.NSGraphicsContext.saveGraphicsState;
  if (spin) {
    const turn = $.NSAffineTransform.transform;
    turn.translateXByYBy(cx, cy);
    turn.rotateByDegrees(spin);
    turn.translateXByYBy(-cx, -cy);
    turn.concat;
  }
  $.NSColor.blackColor.set;
  const at = (deg) => [cx + R * Math.cos((deg * Math.PI) / 180), cy + R * Math.sin((deg * Math.PI) / 180)];
  const ring = $.NSBezierPath.bezierPath;
  ring.appendBezierPathWithArcWithCenterRadiusStartAngleEndAngleClockwise($.NSMakePoint(cx, cy), R, 54, 102, true);
  ring.setLineWidth(1.8);
  ring.stroke;
  const [bx, by] = at(50);
  const [tx, ty] = at(84);
  const len = Math.hypot(tx - bx, ty - by);
  const [nx, ny] = [(ty - by) / len, -(tx - bx) / len]; // 跟箭頭方向垂直
  const half = 2.7;
  const tip = iconPath([[tx, ty], [bx + nx * half, by + ny * half], [bx - nx * half, by - ny * half]]);
  tip.closePath;
  tip.fill;
  $.NSGraphicsContext.restoreGraphicsState;
  if (bars) [[-2.7, 3.6], [0, 7], [2.7, 4.4]].forEach(([dx, h]) => iconRect(cx + dx - 0.9, cy - h / 2, 1.8, h));
}

// 說話中：五條聲波，高度由 animFrame 照音量算好
function drawBars(heights) {
  BAR_X.forEach((x, i) => iconRect(x - 1.1, ICON_H / 2 - heights[i] / 2, 2.2, heights[i]));
}

function drawWarning() {
  $.NSColor.blackColor.set;
  const tri = iconPath([[10, 16.4], [18.25, 1.9], [1.75, 1.9]]);
  tri.closePath;
  tri.setLineWidth(1.6);
  tri.setLineJoinStyle(1);
  tri.fill;
  tri.stroke;
  clearing(() => {
    iconRect(9.05, 6.4, 1.9, 5.2);
    $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(10 - 1.15, 4.35 - 1.15, 2.3, 2.3)).fill;
  });
}

// kind：listening、speaking、working、pasted、nofield、standby、paused、error。frame 給會動的兩種用
function drawGlyph(kind, frame = {}) {
  if (kind === 'speaking') drawBars(frame.heights ?? QUIET);
  else if (kind === 'working') drawBrand({ bars: false, spin: frame.spin ?? 0 });
  else if (kind === 'pasted') iconStroke([[3.6, 8.4], [8.2, 4], [16.6, 13.8]], 2.5);
  else if (kind === 'nofield') { iconStroke([[6.5, 12.5], [13.5, 5.5]], 2); iconStroke([[6.5, 5.5], [13.5, 12.5]], 2); }
  else if (kind === 'error') drawWarning();
  else if (kind === 'standby') withAlpha(0.35, () => drawBrand());
  else if (kind === 'paused') {
    // 標誌加一條斜線（像「禁止」標誌）：斜線兩旁先挖空，線才不會黏在標誌上
    withAlpha(0.75, () => drawBrand());
    const slash = [[2.6, 1.6], [17.4, 16.4]];
    clearing(() => { const gap = iconPath(slash); gap.setLineWidth(4.6); gap.setLineCapStyle(1); gap.stroke; });
    iconStroke(slash, 2.2);
  } else drawBrand();
}

const iconCache = {};
let iconCacheSize = 0;
function iconImage(kind, frame = null) {
  const key = frame ? `${kind}:${frame.key}` : kind;
  if (iconCache[key]) return iconCache[key];
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(ICON_W, ICON_H));
  image.lockFocus;
  drawGlyph(kind, frame ?? {});
  image.unlockFocus;
  image.setTemplate(true);
  // 說話中的聲波高度有很多種組合：快取太多就清掉重來（JXA 長時間跑會一直吃記憶體）
  if (iconCacheSize > 400) { for (const k of Object.keys(iconCache)) if (k.includes(':')) delete iconCache[k]; iconCacheSize = 0; }
  iconCache[key] = image;
  iconCacheSize += 1;
  return image;
}

// 會動的兩種狀態的這一格：說話中聲波高度跟著音量（level 0–1），每條各自晃一點看起來像在聽，高度取整數點（同樣的高度
// 共用一張圖）；辨識中每 0.1 秒轉 30°（1.2 秒一圈）
function animFrame(kind) {
  const now = Date.now();
  if (kind === 'working') {
    const step = Math.floor(now / 100) % 12;
    return { spin: step * 30, key: String(step) };
  }
  if (kind === 'speaking') {
    const fresh = now - levelAt < 400 ? level : level * Math.max(0, 1 - (now - levelAt - 400) / 600); // 沒收到音量就慢慢降下來
    const heights = BAR_X.map((_, i) => {
      const wobble = 0.6 + 0.4 * Math.sin((now / 1000) * (7 + i * 1.7) + i * 1.3);
      return Math.round(Math.max(QUIET[i], 3 + 13 * Math.min(1, fresh * BAR_WEIGHT[i] * wobble * 1.25)));
    });
    return { key: heights.join(','), heights };
  }
  return null;
}

// 選單列圖示要畫哪一種，以及滑鼠停上去的說明
function look() {
  if (flash && Date.now() < flash.until) return flash.kind === 'pasted' ? ['pasted', t('已貼上', 'Pasted')] : ['nofield', t('找不到可以寫的地方，沒寫', "Couldn't find a place to write; nothing written")];
  if (view.state === 'listening') {
    if (hearing) return ['speaking', t('說話中', 'Hearing you')];
    if (working) return ['working', t('辨識中：轉寫與 AI 整理', 'Transcribing and cleaning up')];
    return ['listening', ''];
  }
  if (view.state === 'paused') return ['paused', ''];
  if (view.state === 'error') return ['error', ''];
  return ['standby', ''];
}

// 測試用：目前選單列圖示旁的字、選單第一行、AI 與開關的勾選狀態
function uiSnapshot() {
  if (!statusItem) return null;
  return {
    title: ObjC.unwrap(statusItem.button.title),
    line: ObjC.unwrap(statusLine.title),
    ai: ObjC.unwrap(aiMenuItem.title),
    checked: [aiOffItem, ...Object.values(aiItems), autoFocusItem, commandsItem].map((item) => item.state).join(''),
    commands: ObjC.unwrap(commandsItem.title),
    engine: ObjC.unwrap(engineMenuItem.title),
    cubelv: ObjC.unwrap(cubelvItem.title),
    keys: ObjC.unwrap(keysItem.title),
  };
}

// 診斷：選單列圖示實際的位置寫進 menubar.json（瀏海機型圖示太多時會被擠到瀏海後面看不到）
function dumpFrame() {
  try {
    const win = statusItem.button.window;
    const f = win.frame;
    const screen = $.NSScreen.mainScreen;
    const notch = screen.auxiliaryTopLeftArea;
    const info = {
      x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height,
      visible: statusItem.isVisible, onScreen: win.isVisible,
      appearance: ObjC.unwrap(statusItem.button.effectiveAppearance.name),
      screenWidth: screen.frame.size.width, notchStart: notch ? notch.size.width : null,
      notchEnd: screen.auxiliaryTopRightArea ? screen.frame.size.width - screen.auxiliaryTopRightArea.size.width : null,
    };
    $(JSON.stringify(info)).writeToFileAtomicallyEncodingError(statePath('menubar.json'), true, $.NSUTF8StringEncoding, null);
  } catch (err) { /* 拿不到就算了 */ }
}

let lastTexts = '';
function refresh() {
  if (!statusItem) return;
  const [kind, hint] = look();
  statusItem.button.setImage(iconImage(kind, animFrame(kind)));
  const moving = kind === 'speaking' || kind === 'working';
  if (moving && !animTimer) animTimer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.1, controller, 'animate:', $(), true);
  if (!moving && animTimer) { animTimer.invalidate; animTimer = null; }
  // 動畫時每 0.1 秒會進來一次：字沒變就不重設
  const texts = `${hint}|${label()}|${view.state}`;
  if (texts === lastTexts) return;
  lastTexts = texts;
  statusItem.button.setToolTip(`JarvisVoice：${hint || label()}`);
  statusLine.setTitle(label());
  toggleItem.setTitle(view.state === 'paused' ? t('繼續收音', 'Resume listening') : t('暫停收音', 'Pause listening'));
}

function refreshSettings() {
  if (!aiMenuItem || !cubelvItem || !keysItem || !voiceprintItem) return;
  const { ai } = settings;
  const signedOut = t('（未登入）', ' (not signed in)');
  const missing = ai.provider === 'cubelv' ? signedOut : t('（沒有 key）', ' (no key)');
  aiMenuItem.setTitle(`${t('AI 整理：', 'AI cleanup: ')}${ai.enabled ? `${AI_NAMES[ai.provider]}${ai.ready ? '' : missing}` : t('關', 'Off')}`);
  const engine = settings.engine;
  engineMenuItem.setTitle(`${t('轉寫：', 'Transcription: ')}${ENGINE_NAMES[engine] ?? engine}${engine === 'cubelv' && !settings.cubelv.loggedIn ? signedOut : ''}`);
  for (const [name, item] of Object.entries(engineItems)) item.setState(engine === name ? 1 : 0);
  cubelvItem.setTitle(loginKind === 'in'
    ? t('正在等瀏覽器登入 CubeLV…（點這裡取消）', 'Waiting for CubeLV sign-in in your browser… (click to cancel)')
    : loginKind === 'out' ? t('登出 CubeLV 中…', 'Signing out of CubeLV…')
      : settings.cubelv.loggedIn
        ? t(`登出 CubeLV${settings.cubelv.email ? `（${settings.cubelv.email}）` : ''}`, `Sign out of CubeLV${settings.cubelv.email ? ` (${settings.cubelv.email})` : ''}`)
        : t('用 CubeLV 登入…（不用 key，扣 CubeLV 點數）', 'Sign in with CubeLV… (no key, uses CubeLV credits)'));
  cubelvItem.setEnabled(loginKind !== 'out');
  const keyName = KEY_PROVIDERS[keyProvider]?.name ?? '';
  keysItem.setTitle(keyKind === 'set' ? t(`測試 ${keyName} 的 key 中…`, `Testing your ${keyName} key…`)
    : keyKind === 'clear' ? t(`清除 ${keyName} 的 key 中…`, `Removing your ${keyName} key…`) : t('設定自己的 key…', 'Set up your own key…'));
  keysItem.setEnabled(!keyTask);
  aiOffItem.setState(ai.enabled ? 0 : 1);
  for (const [provider, item] of Object.entries(aiItems)) item.setState(ai.enabled && ai.provider === provider ? 1 : 0);
  autoFocusItem.setState(settings.autoFocus ? 1 : 0);
  commandsItem.setState(settings.commands ? 1 : 0);
  const vp = settings.voiceprint ?? {};
  voiceprintItem.setState(vp.enabled ? 1 : 0);
  // 聲紋在背景學（core/voiceprint.mjs）：選單不分「學好了／還在學」，只有模型沒裝要說
  voiceprintItem.setTitle(vp.enabled && !vp.ready ? t('只聽我的聲音（聲紋模型沒裝，重跑 install.sh）', 'Only my voice (model missing; rerun install.sh)')
    : t('只聽我的聲音（聲紋）', 'Only my voice (voiceprint)'));
  voiceprintResetItem.setEnabled(!!(vp.enabled && vp.ready && vp.enrolled));
  commandsItem.setTitle(settings.decider
    ? t(`語音指令（直接操作 app，${settings.decider} 決策）`, `Voice commands (operate apps, decided by ${settings.decider})`)
    : t('語音指令（直接操作 app）', 'Voice commands (operate apps)'));
}

// 改設定檔：讀進來、改、寫回去；常駐程式看到檔案改了會自己換設定
function updateConfig(change) {
  const path = statePath('config.json');
  let config = {};
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (text && !text.isNil()) {
    try { config = JSON.parse(ObjC.unwrap(text)); } catch (err) {
      openInTextEdit(path); // 設定檔壞了不要蓋掉，打開給人看
      return;
    }
  }
  change(config);
  $(`${JSON.stringify(config, null, 2)}\n`).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function chooseAi(provider) {
  // 還沒登入就選 CubeLV：先登入，登入成功才把 AI 整理切過去（轉寫不動）
  if (provider === 'cubelv' && !settings.cubelv.loggedIn) { runLogin(['--use', 'ai']); return; }
  // 選了還沒有 key 的那家：先貼 key，測通了才把 AI 整理切過去（常駐程式沒報各家的 key 時照舊直接切）
  if (KEY_PROVIDERS[provider] && settings.keys && !settings.keys[provider]) { setUpKey(provider, { ai: true }); return; }
  updateConfig((config) => {
    config.ai = config.ai ?? {};
    config.ai.enabled = !!provider;
    if (provider) config.ai.provider = provider;
  });
}

function chooseEngine(engine) {
  if (engine === 'cubelv' && !settings.cubelv.loggedIn) { runLogin(['--use', 'engine']); return; }
  if (engine === 'openai' && settings.keys && !settings.keys.openai) { setUpKey('openai', { engine: true }); return; }
  updateConfig((config) => { config.engine = engine; });
}

// ── 用 CubeLV 登入／登出：帶起 bin/cubelv-login.mjs，做完就結束；常駐程式看到登入狀態與設定檔改了會自己換 ──

function showAlert(title, text) {
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
  const alert = $.NSAlert.alloc.init;
  alert.setMessageText(title);
  alert.setInformativeText(text);
  alert.runModal;
}

// 帶起 bin/ 裡的程式用的環境：找得到 node、ffmpeg，狀態資料夾跟小程式同一個，提示跟選單同一種語言（從 Finder 開的 app 沒有 LANG）
function childEnv() {
  const env = $.NSMutableDictionary.dictionaryWithDictionary($.NSProcessInfo.processInfo.environment);
  env.setObjectForKey($(`${NODE_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`), $('PATH'));
  env.setObjectForKey($(BUILD.state), $('VOICE_DICTATION_STATE_DIR'));
  env.setObjectForKey($(ZH ? 'zh' : 'en'), $('VOICE_DICTATION_LANG'));
  return env;
}

function runLogin(args) {
  if (loginTask) return;
  try {
    const task = $.NSTask.alloc.init;
    task.setLaunchPath(BUILD.node);
    task.setArguments($([LOGIN, ...args]));
    task.setEnvironment(childEnv());
    const pipe = $.NSPipe.pipe;
    task.setStandardOutput(pipe);
    task.setStandardError($.NSFileHandle.fileHandleWithNullDevice);
    const reader = pipe.fileHandleForReading;
    const center = $.NSNotificationCenter.defaultCenter;
    center.addObserverSelectorNameObject(controller, 'loginOut:', $.NSFileHandleReadCompletionNotification, reader);
    center.addObserverSelectorNameObject(controller, 'loginEnded:', $.NSTaskDidTerminateNotification, task);
    reader.readInBackgroundAndNotify;
    task.launch;
    loginTask = task;
    loginKind = args[0] === 'logout' ? 'out' : 'in';
    loginBuffer = '';
  } catch (err) {
    showAlert(t('CubeLV 登入開不起來', "Couldn't start CubeLV sign-in"), String(err));
  }
  refreshSettings();
}

// 選單的「用 CubeLV 登入…／登出 CubeLV」：登入中再按一次是取消
function cubelvAction() {
  if (loginTask) { if (loginKind === 'in') loginTask.terminate; return; }
  runLogin(settings.cubelv.loggedIn ? ['logout'] : []);
}

function onLoginLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type !== 'cubelv') return;
  if (event.state === 'error' && !['cancelled', 'denied'].includes(event.code)) showAlert(t('沒有登入 CubeLV', 'Not signed in to CubeLV'), event.message);
  else if (event.state === 'done' && event.quotaExceeded) showAlert(t('已登入 CubeLV', 'Signed in to CubeLV'), event.message);
}

function onLoginOut(note) {
  const data = note.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
  if (!data || Number(data.length) === 0) return; // 登入程式結束，等 loginEnded: 處理
  loginBuffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
  const lines = loginBuffer.split('\n');
  loginBuffer = lines.pop();
  for (const line of lines) if (line.trim()) onLoginLine(line.trim());
  note.object.readInBackgroundAndNotify;
}

function onLoginEnded() {
  if (loginBuffer.trim()) onLoginLine(loginBuffer.trim());
  loginBuffer = '';
  loginTask = null;
  loginKind = '';
  refreshSettings();
}

// ── 設定自己的 key：選一家 → 對話框貼 key → 帶起 bin/set-key.mjs 實際測一次，通了才存進鑰匙圈並切過去 ──

// 純選單列的 app 沒有「編輯」選單，對話框裡的 Cmd+V、Cmd+A 不會動：補一個看不到的編輯選單，key 才貼得進去
let editMenuReady = false;
function ensureEditMenu() {
  if (editMenuReady) return;
  editMenuReady = true;
  const app = $.NSApplication.sharedApplication;
  let main = app.mainMenu;
  if (!main || main.isNil()) { main = $.NSMenu.alloc.init; app.setMainMenu(main); }
  const edit = $.NSMenu.alloc.initWithTitle(t('編輯', 'Edit'));
  [[t('還原', 'Undo'), 'undo:', 'z'], [t('剪下', 'Cut'), 'cut:', 'x'], [t('拷貝', 'Copy'), 'copy:', 'c'], [t('貼上', 'Paste'), 'paste:', 'v'], [t('全選', 'Select All'), 'selectAll:', 'a']]
    .forEach(([title, action, key]) => edit.addItem($.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, key)));
  const holder = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(t('編輯', 'Edit'), null, '');
  holder.setSubmenu(edit);
  main.addItem(holder);
}

// 選單存了哪幾家的 key（bin/own-keys.mjs 記的索引，不是秘密）
function savedKeys() {
  const text = $.NSString.stringWithContentsOfFileEncodingError(statePath('own-keys.json'), $.NSUTF8StringEncoding, null);
  if (!text || text.isNil()) return {};
  try { return JSON.parse(ObjC.unwrap(text)) || {}; } catch (err) { return {}; }
}

// 第一步：選要設定哪一家；取消回空字串
function chooseKeyProvider() {
  const saved = savedKeys();
  const ids = Object.keys(KEY_PROVIDERS);
  const alert = $.NSAlert.alloc.init;
  alert.setMessageText(t('設定自己的 key', 'Set up your own key'));
  alert.setInformativeText(t('選要設定哪一家。貼上的 key 會先實際測一次，通了才存進 macOS 鑰匙圈（不寫進設定檔）。',
    'Choose a provider. Your key is tested first and saved to the macOS Keychain only if it works (never to the config file).'));
  const popup = $.NSPopUpButton.alloc.initWithFramePullsDown($.NSMakeRect(0, 0, 340, 26), false);
  for (const id of ids) {
    const p = KEY_PROVIDERS[id];
    popup.addItemWithTitle(`${p.name}${t(`（${p.use}${saved[id] ? '，已設定' : ''}）`, ` (${p.use}${saved[id] ? ', saved' : ''})`)}`);
  }
  // 預設選 AI 整理正在用、卻還沒有 key 的那家
  const current = ids.indexOf(settings.ai.provider);
  if (current >= 0 && settings.ai.enabled && !settings.ai.ready) popup.selectItemAtIndex(current);
  alert.setAccessoryView(popup);
  alert.addButtonWithTitle(t('下一步', 'Next'));
  alert.addButtonWithTitle(t('取消', 'Cancel'));
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
  if (Number(alert.runModal) !== 1000) return ''; // 1000：第一個按鈕
  return ids[Number(popup.indexOfSelectedItem)] || '';
}

// 第二步：貼 key 的對話框（畫面不顯示 key）。回 { key, engine }、{ clear: true }，取消回 null。
// OpenAI 多一個「轉寫也改用 OpenAI」：預設不勾（從「轉寫」子選單選 OpenAI 進來的才預先勾），不動本機辨識
function askKey(id, { engine = false } = {}) {
  const p = KEY_PROVIDERS[id];
  const saved = !!savedKeys()[id];
  const alert = $.NSAlert.alloc.init;
  alert.setMessageText(t(`貼上 ${p.name} 的 key`, `Paste your ${p.name} key`));
  alert.setInformativeText([
    p.about,
    t(`到 ${p.where} 建立。`, `Create one at ${p.where}.`),
    t('按「測試並儲存」會先實際打一次，通了才存進 macOS 鑰匙圈；不通就說原因、不存。', 'Test and Save calls the provider once first; the key is saved to the macOS Keychain only if it works.'),
    ...(saved ? [t('已經存了一把：貼新的會換掉，或按「清除已存的 key」。', 'A key is already saved: paste a new one to replace it, or choose Remove Saved Key.')] : []),
  ].join('\n\n'));
  const width = 340;
  const askEngine = id === 'openai' && settings.engine !== 'openai';
  const height = askEngine ? 58 : 24;
  const box = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, width, height));
  const field = $.NSSecureTextField.alloc.initWithFrame($.NSMakeRect(0, height - 24, width, 24));
  field.setPlaceholderString(p.hint || t('貼上 key', 'Paste your key'));
  box.addSubview(field);
  let check = null;
  if (askEngine) {
    check = $.NSButton.alloc.initWithFrame($.NSMakeRect(0, 0, width, 22));
    check.setButtonType(3); // NSButtonTypeSwitch：勾選框
    check.setTitle(t(`轉寫也改用 OpenAI（目前：${ENGINE_NAMES[settings.engine] ?? settings.engine}）`, `Also use OpenAI for transcription (now: ${ENGINE_NAMES[settings.engine] ?? settings.engine})`));
    check.setState(engine ? 1 : 0);
    box.addSubview(check);
  }
  alert.setAccessoryView(box);
  alert.addButtonWithTitle(t('測試並儲存', 'Test and Save'));
  alert.addButtonWithTitle(t('取消', 'Cancel'));
  if (saved) alert.addButtonWithTitle(t('清除已存的 key', 'Remove Saved Key'));
  alert.window.setInitialFirstResponder(field);
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
  const choice = Number(alert.runModal);
  if (choice === 1002) return { clear: true };
  if (choice !== 1000) return null;
  return { key: ObjC.unwrap(field.stringValue) || '', engine: !!check && Number(check.state) === 1 };
}

// 選單「設定自己的 key…」（id 空的就先問哪一家）；從「AI 整理」「轉寫」選了沒有 key 的那家時直接帶 id 進來：
// ai：測通了一定把 AI 整理切過去；engine：OpenAI 的「轉寫也改用 OpenAI」預先勾
function setUpKey(id = '', { ai = false, engine = false } = {}) {
  if (keyTask) return;
  ensureEditMenu();
  const chosen = id || chooseKeyProvider();
  if (!chosen) return;
  const answer = askKey(chosen, { engine });
  if (!answer) return;
  if (answer.clear) { runKeyTask(['clear', chosen], chosen, ''); return; }
  if (!answer.key.trim()) { showAlert(t('key 沒有存', 'Key not saved'), t('沒有貼上 key。', 'No key was pasted.')); return; }
  runKeyTask(['set', chosen, ...(answer.engine ? ['--engine'] : []), ...(ai ? ['--ai'] : [])], chosen, answer.key);
}

function runKeyTask(args, provider, key) {
  try {
    const task = $.NSTask.alloc.init;
    task.setLaunchPath(BUILD.node);
    task.setArguments($([SET_KEY, ...args]));
    task.setEnvironment(childEnv());
    const out = $.NSPipe.pipe;
    const input = $.NSPipe.pipe;
    task.setStandardOutput(out);
    task.setStandardInput(input);
    task.setStandardError($.NSFileHandle.fileHandleWithNullDevice);
    const reader = out.fileHandleForReading;
    const center = $.NSNotificationCenter.defaultCenter;
    center.addObserverSelectorNameObject(controller, 'keyOut:', $.NSFileHandleReadCompletionNotification, reader);
    center.addObserverSelectorNameObject(controller, 'keyEnded:', $.NSTaskDidTerminateNotification, task);
    reader.readInBackgroundAndNotify;
    task.launch;
    // key 從管子送進去，不放在參數裡（參數 ps 看得到）
    const writer = input.fileHandleForWriting;
    writer.writeData($(key).dataUsingEncoding($.NSUTF8StringEncoding));
    writer.closeFile;
    keyTask = task;
    keyKind = args[0];
    keyProvider = provider;
    keyBuffer = '';
    keyResult = null;
    keyParts = { out: false, task: false };
  } catch (err) {
    showAlert(t('設定 key 的程式開不起來', "Couldn't start key setup"), String(err));
  }
  refreshSettings();
}

function onKeyLine(line) {
  let event;
  try { event = JSON.parse(line); } catch (err) { return; }
  if (event.type === 'key' && ['saved', 'cleared', 'error'].includes(event.state)) keyResult = event;
}

function onKeyOut(note) {
  const data = note.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
  if (!data || Number(data.length) === 0) { keyDone('out'); return; } // 輸出讀完了
  keyBuffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
  const lines = keyBuffer.split('\n');
  keyBuffer = lines.pop();
  for (const line of lines) if (line.trim()) onKeyLine(line.trim());
  note.object.readInBackgroundAndNotify;
}

// 程式結束了：等輸出讀完；2 秒還沒讀完就不等了
function onKeyEnded() {
  keyDone('task');
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(2, controller, 'keyLate:', $(), false);
}

// 輸出讀完、程式也結束了：選單先換回「設定自己的 key…」，再跳結果（通了說「已設定，可以用了」，不通說原因）
function keyDone(part) {
  if (!keyTask) return;
  keyParts[part] = true;
  if (!keyParts.out || !keyParts.task) return;
  if (keyBuffer.trim()) onKeyLine(keyBuffer.trim());
  const result = keyResult;
  keyBuffer = '';
  keyTask = null;
  keyKind = '';
  keyProvider = '';
  keyResult = null;
  refreshSettings();
  if (result?.state === 'saved') showAlert(t('已設定，可以用了', "You're all set"), result.message);
  else if (result?.state === 'cleared') showAlert(t('已清除', 'Removed'), result.message);
  else showAlert(t('key 沒有存', 'Key not saved'), result?.message || t('設定 key 的程式沒有回報就結束了，再試一次。', 'Key setup ended without a result; try again.'));
}

// 開關型的設定（autoFocus、commands）：照常駐程式目前報的狀態反過來
function toggleSetting(key) {
  updateConfig((config) => { config[key] = !settings[key]; });
}

// 只聽我的聲音：開關寫進設定檔的 voiceprint.enabled
function toggleVoiceprint() {
  updateConfig((config) => { config.voiceprint = { ...(config.voiceprint ?? {}), enabled: !settings.voiceprint?.enabled }; });
}

function requestVoiceprintReset() {
  fm().createFileAtPathContentsAttributes(statePath('voiceprint-reset'), $(), $());
}

function requestRevert() {
  fm().createFileAtPathContentsAttributes(statePath('revert-request'), $(), $());
}

function ensureFile(path, text) {
  if (!fm().fileExistsAtPath(path)) $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function openInTextEdit(path) {
  $.NSWorkspace.sharedWorkspace.openFileWithApplication(path, 'TextEdit');
}

function togglePause() {
  const paused = statePath('paused');
  if (fm().fileExistsAtPath(paused)) {
    fm().removeItemAtPathError(paused, null);
    view = { ...view, state: 'starting', message: '' };
  } else {
    fm().createFileAtPathContentsAttributes(paused, $(), $());
    view = { ...view, state: 'paused', message: '' };
  }
  refresh();
}

function copyLast() {
  const text = $.NSString.stringWithContentsOfFileEncodingError(statePath('last.txt'), $.NSUTF8StringEncoding, null);
  if (!text || text.isNil()) return;
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.setStringForType(text, $.NSPasteboardTypeString);
}

function showFlash(kind, ms) {
  flash = { kind, until: Date.now() + ms };
  refresh();
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(ms / 1000 + 0.05, controller, 'flashEnd:', $(), false);
}

// ── 游標旁的小框 ──
// 放在游標下面（下面放不下就放上面）；拿不到游標放視窗下方中間，都沒有就放主螢幕下方中間。
// 左邊一條色條看狀態：藍＝聽著／整理中、綠＝已貼上／完成、橘＝沒貼上／沒完成、紅＝出錯。
// 有哪些階段、標題和內文寫什麼、停多久都在核心（core/bubble.mjs，CubeLV 的頂端 toast 同一份），
// 常駐程式算好送來：{ state, title, body, tone, loud, busy, result, holdMs }，這裡只畫。
const BUBBLE_MAX_TEXT_W = 420;
const BUBBLE_PAD_X = 14;
const BUBBLE_PAD_Y = 8;
const BUBBLE_BAR_W = 3;
// 聽著、整理中、指令做到一半（holdMs 是 null）會一直留著，20 秒沒新消息才收
const BUBBLE_IDLE_S = 20;
let bubblePanel = null;
let bubbleTitle = null;
let bubbleBody = null;
let bubbleBar = null;
let bubbleSpinner = null;
let bubbleTimer = null;
let bubbleVisible = false;
let bubbleWidth = 0; // 同一次顯示中寬度只變寬不變窄，字一直變時小框才不會左右跳

function makeBubble() {
  // 無邊框、不會變成作用中的視窗（不搶游標）、滑鼠點穿過去、每個桌面和全螢幕 app 上都看得到
  const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, 200, 40), 1 << 7, 2, false);
  panel.setFloatingPanel(true);
  panel.setLevel(101); // 跟彈出選單同一層：蓋過一般視窗
  panel.setOpaque(false);
  panel.setBackgroundColor($.NSColor.clearColor);
  panel.setHasShadow(true);
  panel.setIgnoresMouseEvents(true);
  panel.setHidesOnDeactivate(false);
  panel.setCollectionBehavior((1 << 0) | (1 << 4) | (1 << 6) | (1 << 8)); // 所有桌面、不跟著切桌面動、不進 Cmd+`、全螢幕 app 旁邊
  panel.setAppearance($.NSAppearance.appearanceNamed('NSAppearanceNameDarkAqua'));
  // 實心深色底（92% 不透明）：半透明的毛玻璃在白色背景上會變灰，白字看不清楚
  const fx = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, 200, 40));
  fx.setWantsLayer(true);
  fx.layer.setBackgroundColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(0.11, 0.11, 0.12, 0.92).CGColor);
  fx.layer.setCornerRadius(10);
  fx.layer.setMasksToBounds(true);
  panel.setContentView(fx);
  bubbleBar = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, BUBBLE_BAR_W, 40));
  bubbleBar.setWantsLayer(true);
  bubbleBar.layer.setCornerRadius(1.5);
  fx.addSubview(bubbleBar);
  bubbleTitle = $.NSTextField.labelWithString('');
  bubbleTitle.setLineBreakMode(4); // 太長截尾巴
  fx.addSubview(bubbleTitle);
  bubbleBody = $.NSTextField.wrappingLabelWithString('');
  bubbleBody.setFont($.NSFont.systemFontOfSize(13));
  bubbleBody.setTextColor($.NSColor.labelColor);
  bubbleBody.setMaximumNumberOfLines(3);
  bubbleBody.setPreferredMaxLayoutWidth(BUBBLE_MAX_TEXT_W);
  fx.addSubview(bubbleBody);
  // 整理中、指令做到一半：標題旁一個小的轉圈
  bubbleSpinner = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(0, 0, 12, 12));
  bubbleSpinner.setStyle(1);
  bubbleSpinner.setControlSize(2);
  bubbleSpinner.setIndeterminate(true);
  bubbleSpinner.setDisplayedWhenStopped(false);
  fx.addSubview(bubbleSpinner);
  bubblePanel = panel;
}

const BUBBLE_TONES = { blue: 'systemBlueColor', green: 'systemGreenColor', orange: 'systemOrangeColor', red: 'systemRedColor' };

// 小框放哪：at 是左上角原點的螢幕座標（輔助使用的座標），換成 Cocoa 的左下角原點。
// above：放在游標那行上面（已貼上、完成：剛貼的字從游標往右下長，放下面會蓋到）
function placeBubble(at, w, h, above) {
  const screens = $.NSScreen.screens;
  const fullH = screens.objectAtIndex(0).frame.size.height;
  let x;
  let y;
  let screen = $.NSScreen.mainScreen;
  if (at) {
    const px = at.x + Math.min(at.w, 40) / 2;
    const py = fullH - at.y;
    for (let i = 0; i < screens.count; i += 1) {
      const f = screens.objectAtIndex(i).frame;
      if (px >= f.origin.x && px <= f.origin.x + f.size.width && py >= f.origin.y && py <= f.origin.y + f.size.height) screen = screens.objectAtIndex(i);
    }
  }
  const vf = screen.visibleFrame;
  if (at && at.kind === 'caret') {
    x = at.x - BUBBLE_PAD_X;
    const below = fullH - (at.y + at.h) - 8 - h;
    const over = fullH - at.y + 8;
    y = above ? over : below; // 游標下面（像輸入法的候選字）
    if (!above && y < vf.origin.y + 4) y = over; // 下面放不下：放上面
    if (above && y + h > vf.origin.y + vf.size.height - 4) y = below;
  } else if (at && at.kind === 'window') {
    x = at.x + at.w / 2 - w / 2;
    y = fullH - (at.y + at.h) + 56; // 視窗下方中間
  } else {
    x = vf.origin.x + vf.size.width / 2 - w / 2;
    y = vf.origin.y + 80;
  }
  x = Math.min(Math.max(x, vf.origin.x + 8), vf.origin.x + vf.size.width - w - 8);
  y = Math.min(Math.max(y, vf.origin.y + 8), vf.origin.y + vf.size.height - h - 8);
  bubblePanel.setFrameDisplay($.NSMakeRect(x, y, w, h), true);
}

function showBubble(e) {
  if (e.state === 'hide' || (view.state !== 'listening' && e.state !== 'error')) { hideBubble(); return; }
  if (typeof e.title !== 'string') return;
  if (!bubblePanel) makeBubble();
  const { title, body = '', loud = false, busy = false, result = false } = e;
  const color = $.NSColor[BUBBLE_TONES[e.tone] ?? 'systemBlueColor'];
  const titleOnly = !body;
  if (result || !bubbleVisible) bubbleWidth = 0;
  // 只有一行標題（已貼上、聽著）或沒貼上、出錯時標題亮、粗；有內文時標題是小的灰字
  bubbleTitle.setFont(titleOnly ? $.NSFont.systemFontOfSizeWeight(13, 0.23) : $.NSFont.systemFontOfSizeWeight(loud ? 12 : 11, loud ? 0.4 : 0.3));
  bubbleTitle.setTextColor(titleOnly || loud ? $.NSColor.labelColor : $.NSColor.secondaryLabelColor);
  bubbleTitle.setStringValue(title);
  bubbleBody.setStringValue(body);
  bubbleBody.setHidden(titleOnly);
  bubbleBar.layer.setBackgroundColor(color.CGColor);
  const titleSize = bubbleTitle.fittingSize;
  const bodySize = titleOnly ? { width: 0, height: 0 } : bubbleBody.fittingSize;
  const spin = busy ? 16 : 0;
  const textW = Math.min(BUBBLE_MAX_TEXT_W, Math.max(titleSize.width + spin, bodySize.width, 96, bubbleWidth));
  bubbleWidth = textW;
  const left = BUBBLE_PAD_X + BUBBLE_BAR_W + 4;
  const w = Math.ceil(left + textW + BUBBLE_PAD_X);
  const gap = titleOnly ? 0 : 2;
  const h = Math.ceil(BUBBLE_PAD_Y * 2 + titleSize.height + gap + bodySize.height);
  const titleY = h - BUBBLE_PAD_Y - titleSize.height;
  bubbleTitle.setFrame($.NSMakeRect(left, titleY, Math.min(titleSize.width, textW - spin), titleSize.height));
  if (!titleOnly) bubbleBody.setFrame($.NSMakeRect(left, BUBBLE_PAD_Y, textW, bodySize.height));
  bubbleBar.setFrame($.NSMakeRect(BUBBLE_PAD_X - 2, BUBBLE_PAD_Y + 1, BUBBLE_BAR_W, h - BUBBLE_PAD_Y * 2 - 2));
  bubbleSpinner.setFrame($.NSMakeRect(left + Math.min(titleSize.width, textW - spin) + 4, titleY + (titleSize.height - 12) / 2, 12, 12));
  if (busy) bubbleSpinner.startAnimation($());
  else bubbleSpinner.stopAnimation($());
  placeBubble(e.at, w, h, result);
  bubblePanel.setAlphaValue(1);
  bubblePanel.orderFrontRegardless;
  bubbleVisible = true;
  if (bubbleTimer) { bubbleTimer.invalidate; bubbleTimer = null; }
  bubbleTimer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(e.holdMs ? e.holdMs / 1000 : BUBBLE_IDLE_S, controller, 'bubbleFade:', $(), false);
}

function hideBubble() {
  if (bubbleTimer) { bubbleTimer.invalidate; bubbleTimer = null; }
  if (bubblePanel && bubbleVisible) { bubbleSpinner.stopAnimation($()); bubblePanel.orderOut($()); }
  bubbleVisible = false;
}

// 時間到：淡出 0.25 秒再收起來
function fadeBubble() {
  bubbleTimer = null;
  if (!bubblePanel || !bubbleVisible) return;
  bubblePanel.animator.setAlphaValue(0);
  bubbleTimer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.3, controller, 'bubbleHide:', $(), false);
}

function onLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'settings') {
    settings = { ...settings, ...event };
    refreshSettings();
    refresh();
  } else if (event.type === 'state') {
    view = { state: event.state, message: event.message || '', engine: event.engine || view.engine };
    if (view.state !== 'listening') { hearing = false; working = false; }
    if (view.state !== 'listening' && view.state !== 'error') hideBubble();
    refresh();
  } else if (event.type === 'bubble') {
    showBubble(event);
  } else if (event.type === 'hud') {
    // 常駐程式的即時狀態：hearing／listening（有沒有聽到人聲）、level:<0–1>（說話中的音量）、
    // working／idle（辨識中開始、結束）、pasted、nofield
    if (event.line.startsWith('level:')) { level = Number(event.line.slice(6)) || 0; levelAt = Date.now(); }
    else if (event.line === 'hearing') { hearing = true; refresh(); }
    else if (event.line === 'listening') { hearing = false; refresh(); }
    else if (event.line === 'working') { working = true; refresh(); }
    else if (event.line === 'idle') { working = false; refresh(); }
    else if (event.line === 'pasted') showFlash('pasted', 1200);
    else if (event.line === 'nofield') showFlash('nofield', 1800);
  }
}

function onStdout(note) {
  const data = note.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
  if (!data || Number(data.length) === 0) return; // 常駐程式結束，等 ended: 處理
  buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) if (line.trim()) onLine(line.trim());
  note.object.readInBackgroundAndNotify;
}

function scheduleRestart(seconds) {
  if (quitting) return;
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(seconds, controller, 'restart:', $(), false);
}

function onEnded() {
  const waitOther = view.state === 'already-running';
  task = null;
  hearing = false;
  working = false;
  hideBubble();
  if (quitting) return;
  if (!waitOther) view = { ...view, state: 'off', message: '' };
  refresh();
  scheduleRestart(waitOther ? 10 : 3);
}

function startListener() {
  if (quitting || task) return;
  try {
    const t = $.NSTask.alloc.init;
    t.setLaunchPath(BUILD.node);
    t.setArguments($([LISTEN, '--app']));
    t.setEnvironment(childEnv());
    const pipe = $.NSPipe.pipe;
    t.setStandardOutput(pipe);
    t.setStandardError($.NSFileHandle.fileHandleWithNullDevice);
    const reader = pipe.fileHandleForReading;
    const center = $.NSNotificationCenter.defaultCenter;
    center.addObserverSelectorNameObject(controller, 'stdout:', $.NSFileHandleReadCompletionNotification, reader);
    center.addObserverSelectorNameObject(controller, 'ended:', $.NSTaskDidTerminateNotification, t);
    reader.readInBackgroundAndNotify;
    t.launch;
    task = t;
  } catch (err) {
    view = { ...view, state: 'error', message: t(`常駐程式開不起來（${BUILD.node}）：${err}`, `Can't start the background process (${BUILD.node}): ${err}`) };
    refresh();
    scheduleRestart(30);
  }
}

function quitApp() {
  quitting = true;
  if (task) task.terminate;
  if (loginTask) loginTask.terminate;
  if (keyTask) keyTask.terminate;
  $.NSApplication.sharedApplication.terminate($());
}

ObjC.registerSubclass({
  name: 'VoiceDictationController',
  methods: {
    'toggle:': { types: ['void', ['id']], implementation() { togglePause(); } },
    'copyLast:': { types: ['void', ['id']], implementation() { copyLast(); } },
    'openVocabulary:': {
      types: ['void', ['id']],
      implementation() {
        const path = statePath('vocabulary.txt');
        ensureFile(path, t('# 專有名詞：一行一個，# 後面是註解。可以請你的 AI 照 AI_SETUP.md 幫你填。\n', '# Vocabulary: one term per line; # starts a comment. Your AI can fill this in by following AI_SETUP.md.\n'));
        openInTextEdit(path);
      },
    },
    'openConfig:': {
      types: ['void', ['id']],
      implementation() {
        const path = statePath('config.json');
        ensureFile(path, '{\n  "engine": "local"\n}\n');
        openInTextEdit(path);
      },
    },
    'openGuide:': {
      types: ['void', ['id']],
      implementation() {
        const url = ZH ? 'https://github.com/urusaqqrun/jarvis-voice/blob/main/README.zh-TW.md' : GUIDE_URL;
        $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url));
      },
    },
    'quitApp:': { types: ['void', ['id']], implementation() { quitApp(); } },
    'aiOff:': { types: ['void', ['id']], implementation() { chooseAi(''); } },
    'aiOpenai:': { types: ['void', ['id']], implementation() { chooseAi('openai'); } },
    'aiDeepseek:': { types: ['void', ['id']], implementation() { chooseAi('deepseek'); } },
    'aiClaude:': { types: ['void', ['id']], implementation() { chooseAi('claude'); } },
    'aiCubelv:': { types: ['void', ['id']], implementation() { chooseAi('cubelv'); } },
    'engineLocal:': { types: ['void', ['id']], implementation() { chooseEngine('local'); } },
    'engineOpenai:': { types: ['void', ['id']], implementation() { chooseEngine('openai'); } },
    'engineCubelv:': { types: ['void', ['id']], implementation() { chooseEngine('cubelv'); } },
    'engineParallelsandbox:': { types: ['void', ['id']], implementation() { chooseEngine('parallelsandbox'); } },
    'cubelvLogin:': { types: ['void', ['id']], implementation() { cubelvAction(); } },
    'loginOut:': { types: ['void', ['id']], implementation(note) { onLoginOut(note); } },
    'loginEnded:': { types: ['void', ['id']], implementation() { onLoginEnded(); } },
    'ownKeys:': { types: ['void', ['id']], implementation() { setUpKey(); } },
    'keyOut:': { types: ['void', ['id']], implementation(note) { onKeyOut(note); } },
    'keyEnded:': { types: ['void', ['id']], implementation() { onKeyEnded(); } },
    'keyLate:': { types: ['void', ['id']], implementation() { if (keyParts.task) keyDone('out'); } },
    'toggleAutoFocus:': { types: ['void', ['id']], implementation() { toggleSetting('autoFocus'); } },
    'toggleCommands:': { types: ['void', ['id']], implementation() { toggleSetting('commands'); } },
    'toggleVoiceprint:': { types: ['void', ['id']], implementation() { toggleVoiceprint(); } },
    'resetVoiceprint:': { types: ['void', ['id']], implementation() { requestVoiceprintReset(); } },
    'revert:': { types: ['void', ['id']], implementation() { requestRevert(); } },
    'stdout:': { types: ['void', ['id']], implementation(note) { onStdout(note); } },
    'ended:': { types: ['void', ['id']], implementation() { onEnded(); } },
    'restart:': { types: ['void', ['id']], implementation() { startListener(); } },
    'dumpFrame:': { types: ['void', ['id']], implementation() { dumpFrame(); } },
    'flashEnd:': { types: ['void', ['id']], implementation() { if (flash && Date.now() >= flash.until) { flash = null; refresh(); } } },
    'animate:': { types: ['void', ['id']], implementation() { refresh(); } },
    'bubbleFade:': { types: ['void', ['id']], implementation() { fadeBubble(); } },
    'bubbleHide:': { types: ['void', ['id']], implementation() { bubbleTimer = null; hideBubble(); } },
  },
});

function menuItem(title, action) {
  const item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, '');
  if (action) item.setTarget(controller);
  return item;
}

function startUI() {
  fm().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(BUILD.state, true, $(), null);
  controller = $.VoiceDictationController.alloc.init;
  // 新的選單列圖示預設排在最左邊，瀏海機型圖示一多就被擠到瀏海後面看不到：
  // 第一次先放在離螢幕右邊 260 點的位置；之後使用者按 Cmd 拖過的位置系統會自己記住
  const positionKey = 'NSStatusItem Preferred Position VoiceDictation';
  const defaults = $.NSUserDefaults.standardUserDefaults;
  if (defaults.objectForKey(positionKey).isNil()) defaults.setDoubleForKey(260, positionKey);
  statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength(-2); // NSSquareStatusItemLength：固定寬度
  statusItem.setAutosaveName('VoiceDictation');
  const menu = $.NSMenu.alloc.init;
  menu.setAutoenablesItems(false);
  statusLine = menuItem(t('啟動中…', 'Starting…'), null);
  statusLine.setEnabled(false);
  menu.addItem(statusLine);
  menu.addItem($.NSMenuItem.separatorItem);
  toggleItem = menuItem(t('暫停收音', 'Pause listening'), 'toggle:');
  menu.addItem(toggleItem);
  menu.addItem(menuItem(t('複製上一句', 'Copy last sentence'), 'copyLast:'));
  menu.addItem(menuItem(t('換回原文（上一段 AI 整理前）', 'Revert to original (before AI cleanup)'), 'revert:'));
  menu.addItem($.NSMenuItem.separatorItem);
  engineMenuItem = menuItem(t('轉寫：', 'Transcription: '), null);
  const engineMenu = $.NSMenu.alloc.init;
  engineMenu.setAutoenablesItems(false);
  for (const [engine, title] of Object.entries(ENGINE_ITEMS)) {
    engineItems[engine] = menuItem(title, `engine${engine[0].toUpperCase()}${engine.slice(1)}:`);
    engineMenu.addItem(engineItems[engine]);
  }
  engineMenuItem.setSubmenu(engineMenu);
  menu.addItem(engineMenuItem);
  aiMenuItem = menuItem(t('AI 整理：關', 'AI cleanup: Off'), null);
  const aiMenu = $.NSMenu.alloc.init;
  aiMenu.setAutoenablesItems(false);
  aiOffItem = menuItem(t('關（講完一句直接貼）', 'Off (paste each sentence as is)'), 'aiOff:');
  aiMenu.addItem(aiOffItem);
  aiMenu.addItem($.NSMenuItem.separatorItem);
  for (const [provider, name] of Object.entries(AI_NAMES)) {
    const title = provider === 'cubelv' ? t('CubeLV（扣 CubeLV 點數，不用 key）', 'CubeLV (uses CubeLV credits, no key)') : name;
    aiItems[provider] = menuItem(title, `ai${provider[0].toUpperCase()}${provider.slice(1)}:`);
    aiMenu.addItem(aiItems[provider]);
  }
  aiMenuItem.setSubmenu(aiMenu);
  menu.addItem(aiMenuItem);
  autoFocusItem = menuItem(t('自動找輸入框（游標不在輸入框時）', 'Auto-focus (when the cursor isn\'t in a text field)'), 'toggleAutoFocus:');
  menu.addItem(autoFocusItem);
  commandsItem = menuItem(t('語音指令', 'Voice commands'), 'toggleCommands:');
  menu.addItem(commandsItem);
  voiceprintItem = menuItem(t('只聽我的聲音（聲紋）', 'Only my voice (voiceprint)'), 'toggleVoiceprint:');
  menu.addItem(voiceprintItem);
  voiceprintResetItem = menuItem(t('重錄我的聲紋', 'Re-learn my voice'), 'resetVoiceprint:');
  menu.addItem(voiceprintResetItem);
  menu.addItem($.NSMenuItem.separatorItem);
  menu.addItem(menuItem(t('編輯專有名詞…', 'Edit vocabulary…'), 'openVocabulary:'));
  menu.addItem(menuItem(t('編輯設定檔…', 'Edit config…'), 'openConfig:'));
  keysItem = menuItem(t('設定自己的 key…', 'Set up your own key…'), 'ownKeys:');
  menu.addItem(keysItem);
  cubelvItem = menuItem(t('用 CubeLV 登入…', 'Sign in with CubeLV…'), 'cubelvLogin:');
  menu.addItem(cubelvItem);
  menu.addItem(menuItem(t('說明', 'Help'), 'openGuide:'));
  menu.addItem($.NSMenuItem.separatorItem);
  menu.addItem(menuItem(t('結束 JarvisVoice', 'Quit JarvisVoice'), 'quitApp:'));
  statusItem.setMenu(menu);
  refreshSettings();
  refresh();
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(2, controller, 'dumpFrame:', $(), false);
  startListener();
}
