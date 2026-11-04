// 常駐的「輔助使用」小幫手（JXA）：listen.mjs 開一個一直留著，stdin／stdout 一行一個 JSON。
// 讀上下文（app、視窗、網址、輸入框、游標前後、選取）、貼上、選回剛貼的字換掉、找視窗裡的輸入框、對焦；
// 語音指令的操作代理：讀整個視窗的結構樹、點、填字、按鍵、捲動、選選單。
// 不用每句都重開 osascript，每次省 100–200 ms。
//
// 請求 { id, op, ... } → 回覆 { id, ... } 或 { id, error }：
//   check   { ask }                   → { trusted }
//   context { pid, chars, screen }    → { app, window, url, screen, frame, field: { editable, known, role, subrole, secure, label, before, selected, after, handle, caret } }
//                                       screen：要幾個字的「視窗裡看得到的字」（不含輸入框），0 就不讀
//                                       frame：視窗、caret：游標（拿不到就是輸入框）在螢幕上的位置 { x, y, w, h }（左上角原點），給游標旁的小框用
//   paste   { pid, text, dry }        → { result: ok | no-accessibility | not-text-field:<角色> | not-front | dry:<字>, handle }
//                                       按完 Cmd+V 就回覆，等 app 讀剪貼簿（游標動了才算讀完，讀不到游標等 0.35 秒）、還原剪貼簿在回覆之後才做
//   draft   { pid, text, expect, chars } → { result: ok | no-accessibility | no-field | secure | unreadable | has-selection | not-front, handle, continued, before }：
//                                       先寫草稿：跟 paste 一樣貼在游標這裡，但之後要換得掉才寫（讀得到游標前的字、沒有選取）；
//                                       continued：游標前面是不是 expect（前面的草稿）；before：寫之前游標前的字（最多 chars 個）
//   replace { pid, old, text }        → { result: ok | mismatch | no-field | not-front }：游標前面正好是 old 就選起來換成 text（空字串＝刪掉）
//   按鍵（Cmd+V、Delete）只在 pid 確實是最前面的 app 時才送，不然回 not-front
//   targets { pid }                   → { window: {x,y,w,h,title}, candidates: [{ handle, role, subrole, label, x, y, w, h, focused, enabled }] }
//   focus   { handle }                → { ok }
//   read    { handle }                → { value }
//   elements { pid, limit }           → { window, elements: [{ handle, role, subrole, label, x, y, w, h, focused }] }：畫面上可以操作的東西
//   tree    { pid, maxNodes, budgetMs } → { app, window, menus, nodes: [{ depth, kind, role, name, value, off, handle, … }], partial, ocr? }：
//                                       操作代理看的整個視窗結構樹（bin/agent-screen.mjs 轉成核心的節點）
//   act     { pid, handle, action, … } → { result: ok | gone | not-front | failed | …, … }：操作代理的一步。press 點、showMenu 右鍵選單、
//                                       fill 填字、key 按鍵（key：Enter、cmd+l…）、scroll 捲動（direction、amount）、select 選下拉選單（option）、
//                                       menu 選單列（path）、clickAt／rightClickAt 在 (x, y) 點滑鼠（截圖認出來的字沒有元件可以按，用這個）
//   ocr     { pid, ask }              → { permission, items: [{ text, x, y, w, h }] }：截最前面那個視窗（只在記憶體裡）認字；
//                                       順序與接成文字由 bin/ax.mjs 用核心（core/ocr.mjs）處理
// 讀不到畫面的 app（例如 LINE：只有視窗按鈕和輸入框，畫面上的字讀不到）：context 的 screen、elements 會自動改用截圖認字補上
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.import('Vision');
// Vision 認字設定（visionItems）跟 vision-ocr.js 共用一份：vision.js 放在同一個資料夾
eval(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(
  `${ObjC.unwrap($.NSProcessInfo.processInfo.arguments).map((a) => ObjC.unwrap(a)).find((a) => a.endsWith('ax-agent.js')).replace(/ax-agent\.js$/, '')}vision.js`,
  $.NSUTF8StringEncoding, null)));

// AXUIElementRef 在執行期是 CF 物件，全部當 id 傳：JXA 對 AX 的 out 參數型別對不上，自己綁簽名
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'void **']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementCopyParameterizedAttributeValue', ['int', ['id', 'id', 'id', 'void **']]);
ObjC.bindFunction('AXValueCreate', ['id', ['int', 'void *']]);
ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['int', 'int']]);
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CFEqual', ['bool', ['id', 'id']]);
ObjC.bindFunction('CGEventSourceSecondsSinceLastEventType', ['double', ['int', 'int']]);
ObjC.bindFunction('AXUIElementIsAttributeSettable', ['int', ['id', 'id', 'void *']]);

const TEXT_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'];
const K_CFRANGE = 4; // kAXValueCFRangeType

// ---- 讀寫屬性 ----

function attr(el, name) {
  if (!el) return null;
  const ref = Ref();
  return $.AXUIElementCopyAttributeValue(el, $(name), ref) === 0 ? ObjC.castRefToObject(ref[0]) : null;
}

function text(el, name) {
  const v = attr(el, name);
  if (!v) return '';
  const u = ObjC.unwrap(v);
  return typeof u === 'string' ? u : '';
}

function flag(el, name) {
  const v = attr(el, name);
  return v ? ObjC.unwrap(v) === true || ObjC.unwrap(v) === 1 : null;
}

// AXValue 沒辦法直接拆，從 description 讀數字
const describe = (v) => (v ? ObjC.unwrap(v.description) : '');

function rangeOf(el) {
  const m = describe(attr(el, 'AXSelectedTextRange')).match(/location:(-?\d+) length:(\d+)/);
  return m ? { location: Number(m[1]), length: Number(m[2]) } : null;
}

function frameOf(el) {
  const p = describe(attr(el, 'AXPosition')).match(/x:(-?[\d.]+) y:(-?[\d.]+)/);
  const s = describe(attr(el, 'AXSize')).match(/w:([\d.]+) h:([\d.]+)/);
  return p && s ? { x: Number(p[1]), y: Number(p[2]), w: Number(s[1]), h: Number(s[2]) } : null;
}

function rectOf(v) {
  const m = describe(v).match(/x:(-?[\d.]+) y:(-?[\d.]+) w:([\d.]+) h:([\d.]+)/);
  return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : null;
}

// 游標在螢幕上的位置：選取範圍的外框（沒選取就是游標那一條）；有些 app 給 0×0 或原點，改用整個輸入框
function caretOf(el) {
  const range = rangeOf(el);
  if (range) {
    const ref = Ref();
    if ($.AXUIElementCopyParameterizedAttributeValue(el, $('AXBoundsForRange'), rangeValue(range.location, range.length), ref) === 0) {
      const r = rectOf(ObjC.castRefToObject(ref[0]));
      if (r && r.h > 0 && (r.x || r.y)) return r;
    }
  }
  return frameOf(el);
}

// CFRange 是兩個 64-bit 整數，拼成 16 bytes 再包成 AXValue
function rangeValue(location, length) {
  const bytes = [];
  for (let n of [location, length]) for (let i = 0; i < 8; i += 1) { bytes.push(n & 0xff); n = Math.floor(n / 256); }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    b64 += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? A[n & 63] : '=');
  }
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(b64), 0);
  return $.AXValueCreate(K_CFRANGE, data.bytes);
}

function setRange(el, location, length) {
  return $.AXUIElementSetAttributeValue(el, $('AXSelectedTextRange'), rangeValue(location, length)) === 0;
}

function rangeSettable(el) {
  const out = $.NSMutableData.dataWithLength(1);
  return $.AXUIElementIsAttributeSettable(el, $('AXSelectedTextRange'), out.mutableBytes) === 0
    && ObjC.unwrap(out.base64EncodedStringWithOptions(0)) !== 'AA==';
}

function stringForRange(el, location, length) {
  const ref = Ref();
  if ($.AXUIElementCopyParameterizedAttributeValue(el, $('AXStringForRange'), rangeValue(location, length), ref) !== 0) return null;
  const u = ObjC.unwrap(ObjC.castRefToObject(ref[0]));
  return typeof u === 'string' ? u : null;
}

// ---- 元件代號：回給 node 的是數字，之後可以拿來對焦、讀回 ----

const handles = new Map();
let nextHandle = 1;
function keep(el) {
  const id = nextHandle;
  nextHandle += 1;
  handles.set(id, el);
  if (handles.size > 300) handles.delete(handles.keys().next().value);
  return id;
}

function appElement(pid) {
  const app = $.AXUIElementCreateApplication(pid);
  // Chromium、Electron 要先打開輔助樹才讀得到網頁裡的欄位；其他 app 會忽略
  $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true));
  return app;
}

function labelOf(el) {
  const title = attr(el, 'AXTitleUIElement');
  return text(el, 'AXDescription') || text(el, 'AXPlaceholderValue') || text(el, 'AXTitle')
    || (title ? text(title, 'AXValue') : '') || text(el, 'AXHelp');
}

// 目前焦點的輸入框：{ known, editable, el, root, role, subrole, secure }。讀不到（app 不支援輔助功能）就當不知道
function focusedField(app) {
  const el = attr(app, 'AXFocusedUIElement');
  if (!el) return { known: false };
  const role = text(el, 'AXRole');
  const subrole = text(el, 'AXSubrole');
  const secure = subrole === 'AXSecureTextField' || role === 'AXSecureTextField';
  if (TEXT_ROLES.includes(role) || secure) return { known: true, editable: true, el, root: el, role, subrole, secure };
  // 網頁裡的 contenteditable 編輯器：Chromium／WebKit 會掛可編輯的祖先，值和游標要從祖先讀
  const ancestor = attr(el, 'AXEditableAncestor');
  if (ancestor) return { known: true, editable: true, el, root: ancestor, role, subrole, secure: false };
  return { known: true, editable: false, el, role, subrole };
}

function webAreaOf(el) {
  let cur = el;
  for (let i = 0; cur && i < 80; i += 1) {
    if (text(cur, 'AXRole') === 'AXWebArea') return cur;
    cur = attr(cur, 'AXParent');
  }
  return null;
}

// 廣度優先走 AX 樹：webAreas 收網頁區塊（不往裡走），fields 收原生輸入框
function walk(root, limit) {
  const webAreas = [];
  const fields = [];
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < limit) {
    const el = queue.shift();
    seen += 1;
    const role = text(el, 'AXRole');
    if (role === 'AXWebArea') { webAreas.push(el); continue; }
    if (TEXT_ROLES.includes(role)) { fields.push(el); continue; }
    const kids = attr(el, 'AXChildren');
    if (kids) for (let i = 0; i < kids.count; i += 1) queue.push(kids.objectAtIndex(i));
  }
  return { webAreas, fields };
}

function urlOf(web) {
  const v = attr(web, 'AXURL');
  if (!v) return '';
  try { return ObjC.unwrap(v.absoluteString) || ''; } catch (err) { return ''; }
}

// 視窗裡看得到的字（不含輸入框裡的），照畫面由上往下，取最後 chars 個字：給 AI 判斷在討論什麼、專有名詞怎麼寫
function screenText(win, chars) {
  const parts = [];
  const push = (value) => {
    const t = (value || '').replace(/\s+/g, ' ').trim();
    if (t && parts[parts.length - 1] !== t) parts.push(t);
  };
  const { webAreas } = walk(win, 600);
  const params = $.NSDictionary.dictionaryWithObjectsForKeys(
    $([$('AXStaticTextSearchKey'), $.NSNumber.numberWithInt(600), $('AXDirectionNext'), $.NSNumber.numberWithBool(false), $.NSNumber.numberWithBool(true)]),
    $(['AXSearchKey', 'AXResultsLimit', 'AXDirection', 'AXImmediateDescendantsOnly', 'AXVisibleOnly']),
  );
  for (const web of webAreas) {
    const ref = Ref();
    if ($.AXUIElementCopyParameterizedAttributeValue(web, $('AXUIElementsForSearchPredicate'), params, ref) !== 0) continue;
    const list = ObjC.castRefToObject(ref[0]);
    for (let i = 0; i < list.count; i += 1) {
      const el = list.objectAtIndex(i);
      if (attr(el, 'AXEditableAncestor')) continue; // 輸入框裡的字不算
      push(text(el, 'AXValue') || text(el, 'AXTitle') || text(el, 'AXDescription'));
    }
  }
  if (!webAreas.length) {
    // 原生 app：走 AX 樹收靜態文字
    const queue = [win];
    let seen = 0;
    while (queue.length && seen < 2000) {
      const el = queue.shift();
      seen += 1;
      const role = text(el, 'AXRole');
      if (TEXT_ROLES.includes(role)) continue;
      if (role === 'AXStaticText') { push(text(el, 'AXValue')); continue; }
      const kids = attr(el, 'AXChildren');
      if (kids) for (let i = 0; i < kids.count; i += 1) queue.push(kids.objectAtIndex(i));
    }
  }
  const all = parts.join(' ');
  return all.length > chars ? all.slice(all.length - chars) : all;
}

// ---- 讀不到畫面時：截圖認字 ----

const TINY = (e) => e.w < 20 && e.h < 20; // 視窗左上角的關閉、縮放這類小按鈕

// 畫面上能操作的東西，扣掉輸入框和視窗小按鈕，少於 3 個就當這個 app 讀不到畫面（例如 LINE）
function looksOpaque(list) {
  return list.filter((e) => !TEXT_ROLES.includes(e.role) && !TINY(e)).length < 3;
}

// 這個 pid 最前面的一般視窗：{ id, x, y, w, h }
function windowOf(pid) {
  const list = $.CGWindowListCopyWindowInfo(1 | 16, 0); // 螢幕上看得到的、不含桌面
  for (let i = 0; list && i < list.count; i += 1) {
    const w = list.objectAtIndex(i);
    if (Number(ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID'))) !== pid) continue;
    if (Number(ObjC.unwrap(w.objectForKey('kCGWindowLayer'))) !== 0) continue;
    const b = w.objectForKey('kCGWindowBounds');
    const n = (k) => Number(ObjC.unwrap(b.objectForKey(k)));
    return { id: Number(ObjC.unwrap(w.objectForKey('kCGWindowNumber'))), x: n('X'), y: n('Y'), w: n('Width'), h: n('Height') };
  }
  return null;
}

let askedCapture = false;
// 截視窗（只在記憶體裡）→ macOS 內建文字辨識 → 每段字和它在螢幕上的位置。圖片認完就丟，不存檔、不送出去
function ocr({ pid, ask = true }) {
  if (!$.CGPreflightScreenCaptureAccess()) {
    if (ask && !askedCapture) { askedCapture = true; $.CGRequestScreenCaptureAccess(); }
    return { permission: false, items: [] };
  }
  const win = windowOf(pid);
  if (!win) return { permission: true, items: [] };
  // 直接用系統橋接呼叫（自己綁簽名的話 CGRect 參數會傳錯，截成整個螢幕）：只這個視窗、不含陰影、原始解析度
  const image = $.CGWindowListCreateImage($.CGRectNull, $.kCGWindowListOptionIncludingWindow, win.id,
    $.kCGWindowImageBoundsIgnoreFraming | $.kCGWindowImageBestResolution);
  if (!image) return { permission: true, items: [] };
  // 認字設定在 vision.js（跟平行沙盒桌面版同一份）；位置從 0–1 換成螢幕座標
  const items = visionItems(image).map((i) => ({ text: i.text, x: win.x + i.x * win.w, y: win.y + i.y * win.h, w: i.w * win.w, h: i.h * win.h }));
  // 排順序、接成文字在核心（core/ocr.mjs），由 bin/ax.mjs 收到後處理
  return { permission: true, items };
}

function clickAt(x, y, right = false) {
  for (const type of right ? [3, 4] : [1, 2]) { // 左鍵（右鍵）按下、放開
    const ev = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), right ? 1 : 0);
    $.CGEventPost(0, ev);
    delay(0.05);
  }
}

// ---- 操作 ----

function context({ pid, chars = 400, screen = 0 }) {
  const app = appElement(pid);
  const running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  const win = attr(app, 'AXFocusedWindow');
  const out = {
    app: running && !running.isNil() ? ObjC.unwrap(running.localizedName) || '' : '',
    window: text(win, 'AXTitle'),
    url: '',
    field: { known: false, editable: false },
    frame: win ? frameOf(win) : null,
  };
  const f = focusedField(app);
  const web = f.el ? webAreaOf(f.el) : null;
  out.url = web ? urlOf(web) : win ? (walk(win, 300).webAreas.map(urlOf).find(Boolean) || '') : '';
  if (screen && win) {
    out.screen = screenText(win, screen);
    out.screenSource = 'ax';
    // 畫面上的字讀不到、能操作的東西也幾乎沒有：改用截圖認字
    if (!out.screen && looksOpaque(elements({ pid, limit: 40 }).elements)) {
      const seen = ocr({ pid });
      out.screen = '';
      out.screenOcr = seen.items; // bin/ax.mjs 用核心的 ocrText 接成字
      out.screenSource = seen.permission ? 'ocr' : 'no-permission';
    }
  }
  if (!f.known) return out;
  out.field = { known: true, editable: f.editable, role: f.role, subrole: f.subrole, secure: !!f.secure };
  if (!f.editable) return out;
  out.field.label = labelOf(f.root) || labelOf(f.el);
  out.field.handle = keep(f.root);
  out.field.caret = caretOf(f.root);
  const range = rangeOf(f.root);
  const count = Number(ObjC.unwrap(attr(f.root, 'AXNumberOfCharacters')) || 0);
  if (!range) return out;
  const { location, length } = range;
  let value = null;
  let offset = 0;
  if (count > 20000) {
    // 很長的文件只讀游標附近
    offset = Math.max(0, location - chars);
    value = stringForRange(f.root, offset, Math.min(count - offset, length + chars * 2 + (location - offset)));
  } else {
    value = text(f.root, 'AXValue');
  }
  if (typeof value !== 'string') return out;
  const at = location - offset;
  out.field.before = value.slice(Math.max(0, at - chars), at);
  out.field.selected = value.slice(at, at + length);
  out.field.after = value.slice(at + length, at + length + chars);
  return out;
}

function snapshot(pb) {
  const saved = [];
  const items = pb.pasteboardItems;
  for (let i = 0; i < items.count; i += 1) {
    const item = items.objectAtIndex(i);
    const types = item.types;
    const entry = [];
    for (let j = 0; j < types.count; j += 1) {
      const type = types.objectAtIndex(j);
      const data = item.dataForType(type);
      if (data && !data.isNil()) entry.push([type, data]);
    }
    saved.push(entry);
  }
  return saved;
}

function restore(pb, saved) {
  pb.clearContents;
  if (!saved.length) return;
  const objects = $.NSMutableArray.array;
  for (const entry of saved) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const [type, data] of entry) item.setDataForType(data, type);
    objects.addObject(item);
  }
  pb.writeObjects(objects);
}

// flags：kCGEventFlagMask 的組合（Command 0x100000、Shift 0x20000、Option 0x80000、Control 0x40000）
function pressKey(code, flags = 0) {
  const source = $.CGEventSourceCreate(0); // kCGEventSourceStateCombinedSessionState
  const down = $.CGEventCreateKeyboardEvent(source, code, true);
  const up = $.CGEventCreateKeyboardEvent(source, code, false);
  $.CGEventSetFlags(down, flags);
  $.CGEventSetFlags(up, flags);
  $.CGEventPost(0, down); // kCGHIDEventTap
  $.CGEventPost(0, up);
}

const CMD = 0x100000;
const KEY_V = 9;
const KEY_A = 0;
const KEY_DELETE = 51;

// 鍵名 → 鍵碼（美式鍵盤的位置；中文輸入法開著時字母鍵照樣是快捷鍵）
const KEY_CODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, o: 31, u: 32, '[': 33,
  i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50,
  enter: 36, return: 36, tab: 48, space: 49, ' ': 49, backspace: 51, delete: 117, escape: 53, esc: 53,
  home: 115, end: 119, pageup: 116, pagedown: 121, arrowleft: 123, left: 123, arrowright: 124, right: 124,
  arrowdown: 125, down: 125, arrowup: 126, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MODIFIERS = { cmd: CMD, command: CMD, meta: CMD, '⌘': CMD, shift: 0x20000, alt: 0x80000, option: 0x80000, opt: 0x80000, ctrl: 0x40000, control: 0x40000 };

// 「cmd+shift+l」「Enter」「PageDown」→ { code, flags }；認不得回 null
function parseKey(name) {
  const parts = String(name || 'Enter').toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  let flags = 0;
  let code = null;
  for (const part of parts) {
    if (MODIFIERS[part]) flags |= MODIFIERS[part];
    else code = KEY_CODES[part.replace(/\s+/g, '')] ?? null;
  }
  return code === null ? null : { code, flags };
}

// 回覆送出後才做的事（貼上後等 app 讀剪貼簿、還原剪貼簿）：node 不用等，下一個請求才會等
let afterReply = null;
const PASTE_READ_LIMIT = 2; // 秒：游標一直不動（app 不收這段字）也要還原剪貼簿

// 暫存剪貼簿 → 放字 → Cmd+V → （回覆之後）等 app 讀完 → 還原剪貼簿。
// root：寫進去的輸入框，游標動了才算讀完。不能只等固定時間：app 忙的時候太早還原，貼進去的會是使用者原本剪貼簿裡的字
// （11/04 實測剛開的 Chrome 超過 0.35 秒才讀）。讀不到游標才等 0.35 秒
function pasteText(value, dry, root = null) {
  const pb = $.NSPasteboard.generalPasteboard;
  const saved = snapshot(pb);
  const caret = root && !dry ? rangeOf(root) : null;
  pb.clearContents;
  pb.setStringForType($(value), $.NSPasteboardTypeString);
  let placed = '';
  if (dry) placed = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString)) || '';
  else pressKey(KEY_V, CMD);
  afterReply = () => {
    if (caret) {
      until(() => {
        const now = rangeOf(root);
        return !!now && (now.location !== caret.location || now.length !== caret.length);
      }, PASTE_READ_LIMIT);
    } else delay(0.35);
    restore(pb, saved);
  };
  return placed;
}

// 按鍵只會送到最前面的 app：送之前確認最前面的就是要寫的那個，不然 Cmd+V、Delete 會落到別的 app。
// 問 app 自己的 AXFrontmost（系統層的 AXFocusedApplication 在這裡讀不到）
function isFront(pid) {
  return flag($.AXUIElementCreateApplication(pid), 'AXFrontmost') === true;
}

function trusted(ask) {
  if ($.AXIsProcessTrusted()) return true;
  if (ask) $.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $('AXTrustedCheckOptionPrompt')));
  return false;
}

function paste({ pid, text: value, dry, ask }) {
  if (!dry && !trusted(ask)) return { result: 'no-accessibility' };
  const f = pid ? focusedField(appElement(pid)) : { known: false };
  if (f.known && !f.editable) return { result: `not-text-field:${f.role}` };
  if (!dry && pid && !isFront(pid)) return { result: 'not-front' };
  const placed = pasteText(value, dry, f.root ?? null);
  return { result: dry ? `dry:${placed}` : 'ok', handle: f.root ? keep(f.root) : 0 };
}

// 游標前面 length 個字
function textBefore(root, range, length) {
  const start = range.location - length;
  return stringForRange(root, start, length) ?? text(root, 'AXValue').slice(start, range.location);
}

// 網頁編輯器可能把空白存成不換行空白
const sameText = (a, b) => a.replace(/ /g, ' ') === b.replace(/ /g, ' ');

// 游標（沒有選取）前面正好是 expect
function caretAfter(root, expect) {
  const range = rangeOf(root);
  if (!range || range.length || range.location < expect.length) return false;
  return sameText(textBefore(root, range, expect.length), expect);
}

// 網頁、Electron 的輔助使用資訊晚一點才更新（剛貼的字、剛選的範圍）：等一下再說對不上
function until(check, seconds) {
  const stop = Date.now() + seconds * 1000;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= stop) return false;
    delay(0.02);
  }
}

// 先寫草稿：之後換不掉（讀不到游標前的字、改不了選取範圍）、選取了字（又講話可能是要改寫，等 AI 判斷）都不寫，由 listen.mjs 照原本整理好才寫
function draft({ pid, text: value, expect = '', chars = 400 }) {
  if (!trusted(false)) return { result: 'no-accessibility' };
  const f = focusedField(appElement(pid));
  if (!f.known || !f.editable) return { result: 'no-field' };
  if (f.secure) return { result: 'secure' };
  const first = rangeOf(f.root);
  if (!first || !rangeSettable(f.root)) return { result: 'unreadable' };
  if (first.length) return { result: 'has-selection' };
  if (!isFront(pid)) return { result: 'not-front' };
  const continued = !expect || until(() => caretAfter(f.root, expect), 0.25);
  const range = rangeOf(f.root) ?? first;
  if (range.length) return { result: 'has-selection' };
  const take = Math.min(range.location, chars);
  const before = take ? textBefore(f.root, range, take) : '';
  if (take && !before) return { result: 'unreadable' };
  pasteText(value, false, f.root);
  return { result: 'ok', handle: keep(f.root), continued, before };
}

const kCGEventSourceStateHIDSystemState = 1;
const kCGEventLeftMouseDown = 1;
const kCGEventKeyDown = 10;
const TOUCH_SETTLE = 0.3;
const justTouched = () => Math.min(
  $.CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGEventKeyDown),
  $.CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGEventLeftMouseDown),
) < TOUCH_SETTLE;

// 游標前面正好是剛貼的 old：選起來，換成 text（空字串就刪掉）。對不上就不動
function replace({ pid, old, text: value }) {
  if (!trusted(false)) return { result: 'no-accessibility' };
  const f = focusedField(appElement(pid));
  if (!f.editable) return { result: 'no-field' };
  // 剛按過鍵盤、滑鼠（可能正按下送出，app 還沒清空輸入框）：等一下再比對，不然字會貼回清空後的框
  if (justTouched()) delay(TOUCH_SETTLE);
  if (!until(() => caretAfter(f.root, old), 0.25)) return { result: 'mismatch' };
  if (!isFront(pid)) return { result: 'not-front' };
  const range = rangeOf(f.root);
  const start = range.location - old.length;
  if (!setRange(f.root, start, old.length) || !until(() => sameText(text(f.root, 'AXSelectedText'), old), 0.3)) {
    setRange(f.root, range.location, 0);
    return { result: 'mismatch' };
  }
  if (value) pasteText(value, false, f.root);
  else pressKey(KEY_DELETE);
  return { result: 'ok' };
}

function targets({ pid }) {
  const app = appElement(pid);
  const win = attr(app, 'AXFocusedWindow') || attr(app, 'AXMainWindow');
  if (!win) return { window: null, candidates: [] };
  const found = walk(win, 2000);
  const elements = [...found.fields];
  const params = $.NSDictionary.dictionaryWithObjectsForKeys(
    $([$('AXTextFieldSearchKey'), $.NSNumber.numberWithInt(60), $('AXDirectionNext'), $.NSNumber.numberWithBool(false)]),
    $(['AXSearchKey', 'AXResultsLimit', 'AXDirection', 'AXImmediateDescendantsOnly']),
  );
  for (const web of found.webAreas) {
    const ref = Ref();
    if ($.AXUIElementCopyParameterizedAttributeValue(web, $('AXUIElementsForSearchPredicate'), params, ref) !== 0) continue;
    const list = ObjC.castRefToObject(ref[0]);
    for (let i = 0; i < list.count; i += 1) elements.push(list.objectAtIndex(i));
  }
  const candidates = elements.map((el) => ({
    handle: keep(el),
    role: text(el, 'AXRole'),
    subrole: text(el, 'AXSubrole'),
    label: labelOf(el),
    ...(frameOf(el) ?? { x: 0, y: 0, w: 0, h: 0 }),
    focused: flag(el, 'AXFocused') === true,
    enabled: flag(el, 'AXEnabled') !== false,
  }));
  return { window: { ...(frameOf(win) ?? {}), title: text(win, 'AXTitle') }, candidates };
}

function focus({ handle }) {
  const el = handles.get(handle);
  if (!el) return { ok: false };
  $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true));
  delay(0.05);
  return { ok: flag(el, 'AXFocused') === true };
}

function read({ handle }) {
  const el = handles.get(handle);
  if (!el) return { value: null };
  const value = attr(el, 'AXValue');
  const u = value ? ObjC.unwrap(value) : null;
  return { value: typeof u === 'string' ? u : null };
}

// ---- 列出畫面上可以操作的東西（游標在輸入框時判斷是不是指令用，core/flow.mjs 的 judgeInField） ----

const CONTROL_ROLES = ['AXButton', 'AXLink', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXPopUpButton',
  'AXMenuButton', 'AXCheckBox', 'AXRadioButton', 'AXRow', 'AXCell', 'AXDisclosureTriangle', 'AXIncrementor'];
const LEAF_ROLES = ['AXButton', 'AXLink', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXPopUpButton', 'AXMenuButton', 'AXCheckBox', 'AXRadioButton'];

// 元件上的字：標題、說明、值，沒有就拿底下第一段字（清單列、連結常這樣）
function textInside(el, depth = 0) {
  const own = text(el, 'AXTitle') || text(el, 'AXDescription') || text(el, 'AXValue');
  if (own || depth > 3) return own;
  const kids = attr(el, 'AXChildren');
  if (!kids) return '';
  const parts = [];
  for (let i = 0; i < kids.count && parts.join(' ').length < 60; i += 1) {
    const t = textInside(kids.objectAtIndex(i), depth + 1);
    if (t) parts.push(t);
  }
  return parts.join(' ');
}

function elements({ pid, limit = 150, ocr: withOcr = 'never' }) {
  const app = appElement(pid);
  const win = attr(app, 'AXFocusedWindow') || attr(app, 'AXMainWindow');
  if (!win) return { window: null, elements: [] };
  const box = frameOf(win);
  const found = [];
  const webAreas = [];
  const queue = [win];
  let seen = 0;
  while (queue.length && seen < 2500) {
    const el = queue.shift();
    seen += 1;
    const role = text(el, 'AXRole');
    if (role === 'AXWebArea') { webAreas.push(el); continue; }
    if (CONTROL_ROLES.includes(role)) found.push(el);
    if (LEAF_ROLES.includes(role) || role === 'AXRow') continue;
    const kids = attr(el, 'AXChildren');
    if (kids) for (let i = 0; i < kids.count; i += 1) queue.push(kids.objectAtIndex(i));
  }
  const params = $.NSDictionary.dictionaryWithObjectsForKeys(
    $([$(['AXLinkSearchKey', 'AXButtonSearchKey', 'AXTextFieldSearchKey']), $.NSNumber.numberWithInt(300), $('AXDirectionNext'),
      $.NSNumber.numberWithBool(false), $.NSNumber.numberWithBool(true)]),
    $(['AXSearchKey', 'AXResultsLimit', 'AXDirection', 'AXImmediateDescendantsOnly', 'AXVisibleOnly']),
  );
  for (const web of webAreas) {
    const ref = Ref();
    if ($.AXUIElementCopyParameterizedAttributeValue(web, $('AXUIElementsForSearchPredicate'), params, ref) !== 0) continue;
    const list = ObjC.castRefToObject(ref[0]);
    for (let i = 0; i < list.count; i += 1) found.push(list.objectAtIndex(i));
  }
  const out = [];
  for (const el of found) {
    const frame = frameOf(el);
    if (!frame || frame.w < 4 || frame.h < 4) continue;
    // 只留視窗裡看得到的
    if (box && (frame.x + frame.w < box.x || frame.x > box.x + box.w || frame.y + frame.h < box.y || frame.y > box.y + box.h)) continue;
    const role = text(el, 'AXRole');
    const isField = TEXT_ROLES.includes(role);
    // 輸入框：名字只看標籤、提示字，裡面已經打的字另外放（不然搜尋框打了「BU」就會被當成叫「BU」的東西）
    const label = (isField ? labelOf(el) : labelOf(el) || textInside(el)).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!label && !isField) continue;
    const value = isField ? text(el, 'AXValue').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    out.push({ handle: keep(el), role, subrole: text(el, 'AXSubrole'), label, value, ...frame, focused: flag(el, 'AXFocused') === true });
    if (out.length >= limit) break;
  }
  // withOcr：'auto' 讀不到畫面才截圖認字，'always' 一定截（測試用）
  let source = 'ax';
  if (withOcr === 'always' || (withOcr === 'auto' && looksOpaque(out))) {
    const seen = ocr({ pid });
    source = seen.permission ? 'ocr' : 'no-permission';
    // 認出來的字落在已經讀得到的元件裡（例如搜尋框裡打的字）就不重複列，免得決策器點到框裡的字
    const inside = (item) => out.some((e) => {
      const cx = item.x + item.w / 2;
      const cy = item.y + item.h / 2;
      return cx >= e.x && cx <= e.x + e.w && cy >= e.y && cy <= e.y + e.h;
    });
    // 全部交回去：bin/ax.mjs 照核心的閱讀順序排好再取到 limit 個
    for (const item of seen.items.filter((i) => !inside(i))) {
      out.push({ handle: 0, role: 'OCRText', subrole: '', label: item.text.slice(0, 60), x: item.x, y: item.y, w: item.w, h: item.h, focused: false, ocr: true });
    }
  }
  return { window: { ...(box ?? {}), title: text(win, 'AXTitle') }, elements: out, source };
}

// ---- 操作代理：整個視窗的結構樹（bin/agent-screen.mjs 轉成核心 core/agentScreen.mjs 的節點）、照工具動手 ----

// 縮排的一層（給人看的名字在 bin/agent-screen.mjs）
const GROUP_ROLES = ['AXSheet', 'AXDrawer', 'AXPopover', 'AXToolbar', 'AXTabGroup', 'AXOutline', 'AXTable', 'AXList', 'AXBrowser', 'AXMenu'];
const GROUP_SUBROLES = ['AXDialog', 'AXSystemDialog', 'AXFloatingWindow', 'AXApplicationDialog', 'AXApplicationAlertDialog', 'AXLandmarkNavigation', 'AXLandmarkMain'];
const AGENT_CONTROLS = ['AXButton', 'AXLink', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXPopUpButton', 'AXMenuButton',
  'AXCheckBox', 'AXRadioButton', 'AXMenuItem', 'AXSlider', 'AXDisclosureTriangle', 'AXIncrementor', 'AXRow', 'AXCell'];
const EXPANDABLE = ['AXDisclosureTriangle', 'AXPopUpButton', 'AXMenuButton', 'AXComboBox'];
const WINDOW_BUTTONS = ['AXCloseButton', 'AXMinimizeButton', 'AXZoomButton', 'AXFullScreenButton'];
const SCROLL_ACTIONS = { up: 'AXScrollUpByPage', down: 'AXScrollDownByPage', left: 'AXScrollLeftByPage', right: 'AXScrollRightByPage' };

ObjC.bindFunction('AXUIElementCopyActionNames', ['int', ['id', 'void **']]);
ObjC.bindFunction('AXUIElementSetMessagingTimeout', ['int', ['id', 'float']]);
ObjC.bindFunction('AXUIElementCopyMultipleAttributeValues', ['int', ['id', 'id', 'int', 'void **']]);
ObjC.bindFunction('CFGetTypeID', ['unsigned long', ['id']]);
ObjC.bindFunction('AXValueGetTypeID', ['unsigned long', []]);
ObjC.bindFunction('AXValueGetType', ['int', ['id']]);
const AX_VALUE_TYPE = $.AXValueGetTypeID();
const K_AX_ERROR = 5; // kAXValueAXErrorType：這個屬性讀不到

// 一次讀好幾個屬性（Chrome 一個一個讀很慢，一次讀快三倍）：{ 屬性名: 值 }，讀不到的不放
const attrList = (names) => Object.assign([...names], { list: $(names) });
const BASE_ATTRS = attrList(['AXRole', 'AXSubrole', 'AXPosition', 'AXSize', 'AXChildren']);
const CONTROL_ATTRS = attrList(['AXTitle', 'AXDescription', 'AXValue', 'AXPlaceholderValue', 'AXHelp', 'AXTitleUIElement', 'AXFocused', 'AXSelected', 'AXEnabled', 'AXExpanded']);
function attrsOf(el, names) {
  const ref = Ref();
  const out = {};
  if ($.AXUIElementCopyMultipleAttributeValues(el, names.list, 0, ref) !== 0) return out;
  const values = ObjC.castRefToObject(ref[0]);
  for (let i = 0; i < names.length; i += 1) {
    const v = values.objectAtIndex(i);
    if (v && !($.CFGetTypeID(v) === AX_VALUE_TYPE && $.AXValueGetType(v) === K_AX_ERROR)) out[names[i]] = v;
  }
  return out;
}
const str = (v) => {
  const u = v ? ObjC.unwrap(v) : '';
  return typeof u === 'string' ? u : '';
};
const yes = (v) => {
  if (!v) return null;
  const u = ObjC.unwrap(v);
  return u === true || u === 1;
};
function frameFrom(position, size) {
  const p = describe(position).match(/x:(-?[\d.]+) y:(-?[\d.]+)/);
  const z = describe(size).match(/w:([\d.]+) h:([\d.]+)/);
  return p && z ? { x: Number(p[1]), y: Number(p[2]), w: Number(z[1]), h: Number(z[2]) } : null;
}

function actionNames(el) {
  const ref = Ref();
  if ($.AXUIElementCopyActionNames(el, ref) !== 0) return [];
  const list = ObjC.castRefToObject(ref[0]);
  const out = [];
  for (let i = 0; list && i < list.count; i += 1) out.push(ObjC.unwrap(list.objectAtIndex(i)));
  return out;
}

function childrenOf(el) {
  const kids = attr(el, 'AXChildren');
  const out = [];
  for (let i = 0; kids && i < kids.count; i += 1) out.push(kids.objectAtIndex(i));
  return out;
}

const squashText = (t, max) => (t || '').replace(/\s+/g, ' ').trim().slice(0, max);
const intersect = (a, b) => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
};
const outside = (f, clip) => f.x + f.w <= clip.x || f.x >= clip.x + clip.w || f.y + f.h <= clip.y || f.y >= clip.y + clip.h;

function barValue(area, name) {
  const bar = attr(area, name);
  const v = bar ? ObjC.unwrap(attr(bar, 'AXValue')) : null;
  return typeof v === 'number' ? v : null;
}

// 最前面那個視窗的結構樹：照畫面由上往下、一層層。畫面外（被捲動區切掉、視窗外）的東西不往裡面讀（讀整個網頁太慢），
// 能操作的東西本身還是列出來、標畫面外。讀超過 maxNodes 個或 budgetMs 就停（partial）。
// 讀不到畫面（能操作又有名字的東西很少、或一堆沒有名字的清單列，例如 LINE）時一起截圖認字，名字由 bin/agent-screen.mjs 補
function tree({ pid, maxNodes = 3000, budgetMs = 3000 }) {
  const started = Date.now();
  const app = appElement(pid);
  $.AXUIElementSetMessagingTimeout(app, 1); // 卡住的 app 每次最多等 1 秒，不拖垮整個 budget
  const running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  const appName = running && !running.isNil() ? ObjC.unwrap(running.localizedName) || '' : '';
  const bar = attr(app, 'AXMenuBar');
  const menus = bar ? childrenOf(bar).map((m) => text(m, 'AXTitle')).filter(Boolean).slice(1) : []; // 第一個是蘋果選單
  const win = attr(app, 'AXFocusedWindow') || attr(app, 'AXMainWindow');
  if (!win) return { app: appName, window: null, nodes: [], menus, partial: false, ms: Date.now() - started };
  const box = frameOf(win) ?? { x: 0, y: 0, w: 100000, h: 100000 };
  const nodes = [];
  let seen = 0;
  let partial = false;

  const visit = (el, depth, clip, parentRole, inWeb) => {
    if (seen >= maxNodes || Date.now() - started > budgetMs) { partial = true; return; }
    seen += 1;
    const a = attrsOf(el, BASE_ATTRS);
    const role = str(a.AXRole);
    const subrole = str(a.AXSubrole);
    const frame = a.AXPosition && a.AXSize ? frameFrom(a.AXPosition, a.AXSize) : null;
    const off = !!frame && frame.w > 0 && frame.h > 0 && outside(frame, clip);
    const kids = (d, c, web = inWeb) => {
      const list = a.AXChildren;
      for (let i = 0; list && i < list.count; i += 1) visit(list.objectAtIndex(i), d, c, role, web);
    };
    if (role === 'AXWebArea') { kids(depth, clip, true); return; }
    // 網頁裡的表格列、格子只是排版（裡面的連結才是要點的）；樹狀清單、清單裡的列才算一項。
    // 網頁裡看得到的字也給編號：React 這類網頁的可點區塊在輔助使用裡分不出來，點字就是在那個位置點滑鼠
    const control = (AGENT_CONTROLS.includes(role) && !WINDOW_BUTTONS.includes(subrole)
      && !(role === 'AXCell' && parentRole === 'AXRow') && !(inWeb && (role === 'AXCell' || (role === 'AXRow' && !['AXOutline', 'AXList'].includes(parentRole)))))
      || (inWeb && role === 'AXStaticText' && !off);
    if (control) {
      // 原生 app 畫面外的按不到（要先捲過去），不列也不讀名字；網頁裡的照列（Chrome 畫面外的也按得到）
      if ((frame && (frame.w < 2 || frame.h < 2)) || (off && !inWeb)) return;
      const m = attrsOf(el, CONTROL_ATTRS);
      const isField = TEXT_ROLES.includes(role);
      const label = str(m.AXDescription) || str(m.AXPlaceholderValue) || str(m.AXTitle) || (m.AXTitleUIElement ? text(m.AXTitleUIElement, 'AXValue') : '') || str(m.AXHelp);
      // 輸入框：名字只看標籤、提示字，裡面已經打的字另外放
      const name = squashText(isField ? label : label || (role === 'AXStaticText' ? str(m.AXValue) : textInside(el)), 80);
      if (role === 'AXStaticText' && !name) return;
      const secure = subrole === 'AXSecureTextField';
      const value = isField && !secure ? squashText(str(m.AXValue), 60) : '';
      const checkable = role === 'AXCheckBox' || role === 'AXRadioButton';
      nodes.push({
        depth, kind: 'control', role, subrole, parent: parentRole, name, value, off, handle: keep(el), ...(frame ?? {}),
        focused: yes(m.AXFocused) === true, selected: yes(m.AXSelected) === true, enabled: yes(m.AXEnabled) !== false,
        // 很多 app 每顆按鈕都回「沒展開」：只有展開鈕、樹狀清單的列、下拉的東西才看收起
        expanded: EXPANDABLE.includes(role) || parentRole === 'AXOutline' ? yes(m.AXExpanded) : yes(m.AXExpanded) === true || null,
        checked: checkable ? yes(m.AXValue) : null,
      });
      return;
    }
    if (off) return;
    if (role === 'AXHeading') {
      const name = squashText(textInside(el), 60);
      if (name) nodes.push({ depth, kind: 'heading', name });
      return;
    }
    if (role === 'AXStaticText') {
      const name = squashText(text(el, 'AXValue') || text(el, 'AXTitle') || text(el, 'AXDescription'), 80);
      if (name) nodes.push({ depth, kind: 'text', name });
      return;
    }
    if (role === 'AXScrollArea') {
      const inner = frame ? intersect(clip, frame) : clip;
      const v = barValue(el, 'AXVerticalScrollBar');
      const h = barValue(el, 'AXHorizontalScrollBar');
      const web = childrenOf(el).find((k) => text(k, 'AXRole') === 'AXWebArea');
      const canScroll = v !== null || h !== null || !!web || actionNames(el).some((n) => /^AXScroll.*ByPage$/.test(n));
      if (!canScroll) { kids(depth, inner); return; }
      const states = [];
      if (v !== null) { if (v > 0.005) states.push('上面還有'); if (v < 0.995) states.push('下面還有'); }
      if (h !== null) { if (h > 0.005) states.push('左邊還有'); if (h < 0.995) states.push('右邊還有'); }
      const name = squashText(text(el, 'AXDescription') || text(el, 'AXTitle') || (web ? text(web, 'AXTitle') || text(web, 'AXDescription') : ''), 40);
      nodes.push({ depth, kind: 'scroll', name, states, web: !!web, handle: keep(el), ...(frame ?? {}) });
      kids(depth + 1, inner);
      return;
    }
    if (GROUP_ROLES.includes(role) || GROUP_SUBROLES.includes(subrole)) {
      nodes.push({ depth, kind: 'group', role, subrole, name: squashText(text(el, 'AXTitle') || text(el, 'AXDescription'), 40) });
      kids(depth + 1, clip);
      return;
    }
    kids(depth, clip);
  };
  for (const kid of childrenOf(win)) visit(kid, 0, box, 'AXWindow', false);

  // 讀不到畫面：截圖認字補（LINE 的對話清單只有沒有名字的列）
  const controls = nodes.filter((n) => n.kind === 'control');
  const named = controls.filter((n) => n.name && !TEXT_ROLES.includes(n.role)).length;
  const nameless = controls.filter((n) => !n.name && !n.off && ['AXRow', 'AXCell'].includes(n.role)).length;
  const texts = nodes.filter((n) => n.kind === 'text' || n.kind === 'heading').length;
  const treeMs = Date.now() - started;
  const shot = named < 3 || (nameless >= 3 && texts < 3) ? ocr({ pid }) : null;
  return {
    app: appName, window: { ...box, title: text(win, 'AXTitle') }, nodes, menus, partial, seen, treeMs, ms: Date.now() - started,
    ...(shot ? { ocr: shot } : {}),
  };
}

function press(el) {
  return ['AXPress', 'AXConfirm', 'AXPick'].some((name) => $.AXUIElementPerformAction(el, $(name)) === 0);
}

function centerOf(el) {
  const f = frameOf(el);
  return f && f.w > 0 && f.h > 0 ? { x: f.x + f.w / 2, y: f.y + f.h / 2 } : null;
}

// 捲之前、之後比對有沒有動：捲軸的值，沒有捲軸（網頁）就看裡面前幾個東西的位置
function scrollMark(area) {
  const bars = [barValue(area, 'AXVerticalScrollBar'), barValue(area, 'AXHorizontalScrollBar')];
  const firsts = [];
  const queue = childrenOf(area);
  while (queue.length && firsts.length < 6) {
    const el = queue.shift();
    const f = frameOf(el);
    if (f) firsts.push(`${Math.round(f.x)},${Math.round(f.y)}`);
    if (firsts.length < 3) queue.push(...childrenOf(el).slice(0, 3));
  }
  return JSON.stringify([bars, firsts]);
}

// 捲動：先用捲動區自己的「捲一頁」動作（原生的捲動區有）；沒有（網頁）就把滑鼠移過去送滾輪，再移回原位
function scrollArea(area, direction, amount, front) {
  const before = scrollMark(area);
  let done = false;
  for (let i = 0; i < amount; i += 1) {
    if ($.AXUIElementPerformAction(area, $(SCROLL_ACTIONS[direction] || SCROLL_ACTIONS.down)) !== 0) break;
    done = true;
  }
  if (!done) {
    if (!front) return { result: 'not-front' };
    const f = frameOf(area);
    if (!f) return { result: 'failed' };
    const vertical = direction === 'up' || direction === 'down';
    const page = Math.round((vertical ? f.h : f.w) * 0.85);
    // 滾輪往上（正）是看上面的內容
    const sign = direction === 'up' || direction === 'left' ? 1 : -1;
    const home = $.CGEventGetLocation($.CGEventCreate($()));
    $.CGWarpMouseCursorPosition($.CGPointMake(f.x + f.w / 2, f.y + f.h / 2));
    for (let i = 0; i < amount; i += 1) {
      const ev = $.CGEventCreateScrollWheelEvent2($(), 0, 2, vertical ? sign * page : 0, vertical ? 0 : sign * page, 0); // 0：以像素計
      $.CGEventPost(0, ev);
      delay(0.05);
    }
    $.CGWarpMouseCursorPosition(home);
  }
  delay(0.3);
  return { result: 'ok', moved: scrollMark(area) !== before };
}

function scrollAreaOf(el) {
  let cur = el;
  for (let i = 0; cur && i < 30; i += 1) {
    if (text(cur, 'AXRole') === 'AXScrollArea') return cur;
    cur = attr(cur, 'AXParent');
  }
  return null;
}

// 視窗裡最大的捲動區（沒給 ref 的捲動＝整頁）
function mainScrollArea(win) {
  let best = null;
  let bestSize = 0;
  const queue = [win];
  let seen = 0;
  while (queue.length && seen < 400) {
    const el = queue.shift();
    seen += 1;
    if (text(el, 'AXRole') === 'AXScrollArea') {
      const f = frameOf(el);
      const size = f ? f.w * f.h : 0;
      if (size > bestSize) { best = el; bestSize = size; }
      continue;
    }
    queue.push(...childrenOf(el));
  }
  return best;
}

// 下拉選單：按開，從跳出來的選單挑字對得上的那一項
function choose(el, option) {
  if (!press(el)) return { result: 'failed' };
  delay(0.3);
  const menu = childrenOf(el).find((k) => text(k, 'AXRole') === 'AXMenu');
  const items = menu ? childrenOf(menu).filter((k) => text(k, 'AXTitle')) : [];
  const titles = items.map((k) => text(k, 'AXTitle'));
  const pick = items[titles.indexOf(option)] ?? items[titles.findIndex((t) => t.includes(option))];
  if (pick && press(pick)) return { result: 'ok' };
  if (menu) $.AXUIElementPerformAction(menu, $('AXCancel'));
  return { result: 'no-option', options: titles.slice(0, 40) };
}

// 選單列：path 是一層層的名字（[檔案, 新增視窗]）；對不到時回那一層有哪些
function menuPick(pid, path) {
  const bar = attr(appElement(pid), 'AXMenuBar');
  if (!bar) return { result: 'no-menu', options: [] };
  let items = childrenOf(bar).slice(1);
  for (let i = 0; i < path.length; i += 1) {
    const titles = items.map((k) => text(k, 'AXTitle'));
    const name = String(path[i]).trim();
    const at = titles.indexOf(name) >= 0 ? titles.indexOf(name) : titles.findIndex((t) => t && t.includes(name));
    if (at < 0) return { result: 'no-menu', options: titles.filter(Boolean).slice(0, 40), level: i };
    const item = items[at];
    if (i === path.length - 1) {
      if (flag(item, 'AXEnabled') === false) return { result: 'disabled' };
      return { result: press(item) ? 'ok' : 'failed' };
    }
    const menu = childrenOf(item).find((k) => text(k, 'AXRole') === 'AXMenu');
    items = menu ? childrenOf(menu) : [];
  }
  return { result: 'no-menu', options: [] };
}

// 操作代理的一步。handle 是 tree 給的代號；x、y 是截圖認出來的字的位置（沒有元件可以按，就點那裡）。
// 真的按鍵、點滑鼠、滾輪只在這個 app 在最前面時送（不然會落到別的 app），回 not-front
function act({ pid, handle, action, text: value = '', x, y, key, direction = 'down', amount = 1, option = '', path = [] }) {
  const front = isFront(pid);
  if (action === 'clickAt' || action === 'rightClickAt') {
    if (!front) return { result: 'not-front' };
    clickAt(x, y, action === 'rightClickAt');
    return { result: 'ok' };
  }
  if (action === 'menu') return menuPick(pid, path);
  const el = handle ? handles.get(handle) : null;
  if (handle && !el) return { result: 'gone' };
  if (action === 'key') {
    const k = parseKey(key);
    if (!k) return { result: 'unknown-key' };
    // 不在最前面不送按鍵；只有 Enter 可以改用元件自己的「確認」（搜尋框送出）
    if (!front) return { result: el && k.code === 36 && !k.flags && $.AXUIElementPerformAction(el, $('AXConfirm')) === 0 ? 'ok' : 'not-front' };
    if (el) { $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true)); delay(0.1); }
    pressKey(k.code, k.flags);
    return { result: 'ok' };
  }
  if (action === 'scroll') {
    const win = attr(appElement(pid), 'AXFocusedWindow') || attr(appElement(pid), 'AXMainWindow');
    const area = el ? scrollAreaOf(el) : win ? mainScrollArea(win) : null;
    if (!area) return { result: 'no-scroll-area' };
    return scrollArea(area, direction, Math.max(1, Math.min(5, Number(amount) || 1)), front);
  }
  if (!el) return { result: 'gone' };
  if (action === 'press') {
    if (press(el)) return { result: 'ok' };
    // 沒有按的動作（LINE 的對話清單列這類）：在正中間點一下滑鼠，最像真人；不在最前面就選起來
    const c = centerOf(el);
    if (front && c) { clickAt(c.x, c.y, false); return { result: 'ok' }; }
    if ($.AXUIElementSetAttributeValue(el, $('AXSelected'), $.NSNumber.numberWithBool(true)) === 0) return { result: 'ok' };
    return { result: 'failed' };
  }
  if (action === 'showMenu') {
    if ($.AXUIElementPerformAction(el, $('AXShowMenu')) === 0) return { result: 'ok' };
    const c = centerOf(el);
    if (!front || !c) return { result: 'not-front' };
    clickAt(c.x, c.y, true);
    return { result: 'ok' };
  }
  if (action === 'select') return choose(el, option);
  // 填字：app 在最前面照真人的方式（對焦、全選、貼上，網頁的輸入框最穩）；不在前面直接設值
  if (action === 'fill') {
    if (!front) {
      if ($.AXUIElementSetAttributeValue(el, $('AXValue'), $(value)) !== 0 || text(el, 'AXValue') !== value) return { result: 'not-front' };
      return { result: 'ok' };
    }
    $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true));
    delay(0.1);
    pressKey(KEY_A, CMD); // 全選，填進去的字取代原本的
    pasteText(value, false);
    return { result: 'ok' };
  }
  return { result: 'failed' };
}

const OPS = {
  check: ({ ask }) => ({ trusted: trusted(ask) }),
  context,
  paste,
  draft,
  replace,
  targets,
  focus,
  read,
  elements,
  tree,
  act,
  ocr: (args) => ocr(args),
};

// ---- 主迴圈：一行一個請求 ----

function reply(out, message) {
  out.writeData($(`${JSON.stringify(message)}\n`).dataUsingEncoding($.NSUTF8StringEncoding));
}

function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  let buffer = '';
  for (;;) {
    const data = input.availableData;
    if (Number(data.length) === 0) return ''; // node 關掉 stdin 就結束
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      let request = {};
      try {
        request = JSON.parse(line);
        const op = OPS[request.op];
        if (!op) throw new Error(`不認得的操作 ${request.op}`);
        reply(out, { id: request.id, ...op(request) });
      } catch (err) {
        reply(out, { id: request.id, error: String(err) });
      }
      if (afterReply) {
        const later = afterReply;
        afterReply = null;
        try { later(); } catch (err) { /* 剪貼簿還原不了：使用者的剪貼簿會是剛貼的字 */ }
      }
    }
  }
}
