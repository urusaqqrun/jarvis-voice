// Mac 小程式的操作代理畫面接頭：讀最前面那個 app 的輔助使用樹（AX 小幫手的 tree），轉成核心的節點（core/agentScreen.mjs），
// 照 AI 挑的工具動手。畫面怎麼寫給 AI 看、編號、太長怎麼裁、小框寫什麼都在核心，網頁版（lib/voice/domAgent.ts）同一份。
// 讀不到樹的 app（例如 LINE 的對話清單只有沒有名字的列）用截圖認字補：沒有名字的東西拿它範圍裡認出來的字當名字，
// 其他認出來的字列成「畫面上的字」，點下去是點那個位置。
// Mac 自己的工具：右鍵選單、選單列、切換 app、打開網址（沒有觸控，沒有長按、滑動；沒有共通的「上一頁」，用按鍵）。

import { execFile } from 'node:child_process';
import { createAgentScreen, missingRef } from '../core/agentScreen.mjs';
import { standardTools } from '../core/agent.mjs';
import { readingOrder } from '../core/ocr.mjs';

const ROLE_NAMES = {
  AXButton: '按鈕', AXLink: '連結', AXTextField: '輸入框', AXSearchField: '輸入框', AXTextArea: '多行輸入框', AXComboBox: '下拉輸入框',
  AXPopUpButton: '下拉選單', AXMenuButton: '選單按鈕', AXCheckBox: '勾選框', AXRadioButton: '選項', AXRow: '清單項目', AXCell: '格子',
  AXMenuItem: '選單項目', AXSlider: '滑桿', AXDisclosureTriangle: '展開鈕', AXIncrementor: '增減鈕', AXStaticText: '字',
};
const GROUP_NAMES = {
  AXSheet: '對話框', AXPopover: '對話框', AXDrawer: '側欄', AXToolbar: '工具列', AXTabGroup: '分頁列',
  AXOutline: '清單', AXTable: '清單', AXList: '清單', AXBrowser: '清單', AXMenu: '選單',
};
const GROUP_SUBROLE_NAMES = {
  AXDialog: '對話框', AXSystemDialog: '對話框', AXFloatingWindow: '對話框', AXApplicationDialog: '對話框', AXApplicationAlertDialog: '對話框',
  AXLandmarkNavigation: '側欄／導覽', AXLandmarkMain: '主畫面',
};
const FIELDS = ['AXTextField', 'AXSearchField', 'AXTextArea', 'AXComboBox'];
const SETTLE_MS = 500;
const OPEN_SETTLE_MS = 1200; // 切換 app、打開網址之後等視窗出來

export const MAC_TOOLS = [
  ...standardTools(['click', 'fill']),
  { name: 'press_key', args: 'key（Enter、Escape、Tab、Backspace、ArrowDown、PageDown…；組合鍵寫成 cmd+l、cmd+shift+t）, ref（可省略：游標所在的地方）', about: '按一個鍵或組合鍵' },
  ...standardTools(['scroll', 'select', 'wait']),
  { name: 'right_click', args: 'ref', about: '在 ref 上按右鍵（叫出右鍵選單）' },
];

export const MAC_APP_TOOLS = [
  { name: 'menu', args: 'path（選單列一層層的名字，例如 ["檔案", "新增視窗"]）', about: '選選單列裡的項目（這個 app 的指令都在選單列）' },
  { name: 'open_app', args: 'name（app 名稱，例如 LINE、Safari、系統設定）', about: '打開或切換到某個 app' },
  { name: 'open_url', args: 'url', about: '用預設瀏覽器打開網址' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function roleName(n) {
  if (n.role === 'AXCheckBox' && ['AXSwitch', 'AXToggle'].includes(n.subrole)) return '開關';
  if ((n.role === 'AXRadioButton' && n.parent === 'AXTabGroup') || n.subrole === 'AXTabButton') return '分頁';
  return ROLE_NAMES[n.role] ?? '按鈕';
}

// 順序跟網頁版一樣：選中、勾了、展開／收起、不能按，搜尋框放最前面，游標在這放最後
function statesOf(n) {
  const out = [];
  if (n.selected || (n.role === 'AXRadioButton' && n.checked)) out.push('選中');
  if (n.role === 'AXCheckBox' && n.checked) out.push('勾了');
  if (n.expanded === true) out.push('展開');
  else if (n.expanded === false) out.push('收起');
  if (n.enabled === false) out.push('不能按');
  if (n.role === 'AXSearchField' || n.subrole === 'AXSearchField') out.unshift('搜尋框');
  if (n.focused) out.push('游標在這');
  return out;
}

const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const within = (item, box) => {
  const c = center(item);
  return box.w > 0 && box.h > 0 && c.x >= box.x && c.x <= box.x + box.w && c.y >= box.y && c.y <= box.y + box.h;
};

/** AX 小幫手 tree 的結果 → 核心的節點（截圖認出來的字補進沒有名字的東西，剩下的列成「畫面上的字」） */
export function treeNodes(res) {
  const shot = readingOrder(res.ocr?.items ?? []);
  const used = new Set();
  const nodes = [];
  for (const n of res.nodes ?? []) {
    const { depth } = n;
    if (n.kind === 'group') {
      nodes.push({ depth, kind: 'group', role: GROUP_SUBROLE_NAMES[n.subrole] ?? GROUP_NAMES[n.role] ?? '區塊', name: n.name });
    } else if (n.kind === 'heading' || n.kind === 'text') {
      nodes.push({ depth, kind: n.kind, name: n.name });
    } else if (n.kind === 'scroll') {
      nodes.push({ depth, kind: 'scroll', name: n.name, states: n.states ?? [], target: { handle: n.handle } });
    } else {
      // 這個東西範圍裡認出來的字：沒有名字就拿來當名字；有名字的也收掉，免得同一段字再列一次
      const box = { x: n.x, y: n.y, w: n.w, h: n.h };
      const inside = shot.filter((item, i) => !used.has(i) && !n.off && within(item, box));
      inside.forEach((item) => used.add(shot.indexOf(item)));
      // 圖示被認成一兩個字（「①」「个」）不算名字
      const seen = inside.map((item) => item.text).join(' ').trim();
      const name = n.name || (FIELDS.includes(n.role) || seen.length < 2 ? '' : seen);
      nodes.push({
        depth, kind: 'control', role: roleName(n), name, value: n.value, states: statesOf(n), off: !!n.off,
        target: { handle: n.handle, field: FIELDS.includes(n.role) },
      });
    }
  }
  const rest = shot.filter((_, i) => !used.has(i));
  if (rest.length) {
    nodes.push({ depth: 0, kind: 'group', role: '截圖認出來的字（讀不到結構，點下去是點那個位置）' });
    for (const item of rest) nodes.push({ depth: 1, kind: 'control', role: '畫面上的字', name: item.text, target: { at: center(item) } });
  }
  return nodes;
}

export function treeHeader(res) {
  return [
    res.app ? `App：${res.app}${res.window?.title ? `；視窗：${res.window.title}` : ''}` : '最前面沒有 app',
    res.app && !res.window ? '（這個 app 沒有打開的視窗）' : '',
    res.menus?.length ? `選單列（用 menu 選裡面的項目）：${res.menus.join('、')}` : '',
    res.partial ? '（畫面很大，只讀了前面一部分；要的東西不在下面就捲動，或用選單列）' : '',
    res.ocr && !res.ocr.permission ? '（這個 app 讀不到畫面，要截圖認字，但 JarvisVoice 還沒有「螢幕錄影」權限）' : '',
  ].filter(Boolean);
}

const RESULT_NOTES = {
  'not-front': '這個 app 不在最前面，沒做（按鍵、點擊會落到別的 app）',
  failed: '按不下去',
  'no-scroll-area': '畫面上沒有可以捲的地方',
  disabled: '這個選單項目現在不能按',
};

// AX 小幫手回的 { result, … } → 核心要的 { ok, note }
function outcome(r, ref, extra = {}) {
  if (!r) return { ok: false, note: 'AX 小幫手沒回' };
  if (r.result === 'ok') return { ok: true, ...extra };
  if (r.result === 'gone') return missingRef(ref);
  return { ok: false, note: RESULT_NOTES[r.result] ?? r.result };
}

const pathOf = (raw) => (Array.isArray(raw) ? raw : String(raw ?? '').split(/\s*[>＞›/／]\s*/)).map((p) => String(p).trim()).filter(Boolean);

// ax：bin/ax.mjs 的 createAx()；frontApp() → { pid }（每一步看最前面的那個 app，切到別的 app 就跟著看它）；
// openApp(name) → 有沒有打開；openUrl(url) → 有沒有打開
export function createMacAgentScreen({ ax, frontApp, openApp, openUrl = defaultOpenUrl, log = () => {}, maxNodes, budgetMs }) {
  let pid = 0;
  const call = (op, args, timeoutMs) => ax.call(op, { pid, ...args }, timeoutMs).catch((err) => { log(`AX 小幫手 ${op} 失敗：${err.message}`); return null; });

  async function read() {
    pid = (await frontApp()).pid;
    if (!pid) return { nodes: [], header: ['最前面沒有 app'] };
    const res = await call('tree', { maxNodes, budgetMs }, 20000);
    if (!res) return { nodes: [], header: ['讀不到最前面這個 app 的畫面'] };
    log(`操作代理讀畫面：${res.app}，${res.nodes.length} 個，${res.ms} ms（讀樹 ${res.treeMs} ms，走了 ${res.seen} 個）${res.partial ? '（沒讀完）' : ''}${res.ocr ? '，截圖認字' : ''}`);
    return { nodes: treeNodes(res), header: treeHeader(res) };
  }

  let header = [];
  const screen = createAgentScreen({
    tools: MAC_TOOLS,
    async read() {
      const view = await read();
      header = view.header;
      return view.nodes;
    },
    header: () => header,

    async act(call_, target) {
      const args = call_.args ?? {};
      const ref = args.ref != null ? String(args.ref) : '';
      switch (call_.tool) {
        case 'click':
        case 'right_click': {
          if (!target) return missingRef(ref);
          const right = call_.tool === 'right_click';
          if (target.at) return outcome(await call('act', { action: right ? 'rightClickAt' : 'clickAt', ...target.at }), ref);
          return outcome(await call('act', { action: right ? 'showMenu' : 'press', handle: target.handle }), ref);
        }
        case 'fill':
          if (!target) return missingRef(ref);
          if (!target.field) return { ok: false, note: `${ref} 不是輸入框` };
          return outcome(await call('act', { action: 'fill', handle: target.handle, text: String(args.text ?? '') }), ref);
        case 'press_key': {
          const key = String(args.key ?? 'Enter');
          const r = await call('act', { action: 'key', key, handle: target?.handle ?? 0 });
          return r?.result === 'unknown-key' ? { ok: false, note: `不認得「${key}」這個鍵` } : outcome(r, ref);
        }
        case 'scroll': {
          const r = await call('act', { action: 'scroll', handle: target?.handle ?? 0, direction: String(args.direction ?? 'down'), amount: Number(args.amount) || 1 });
          return outcome(r, ref, { note: r?.moved ? '捲了' : '捲不動，已經到邊了' });
        }
        case 'select': {
          if (!target) return missingRef(ref);
          const option = String(args.option ?? '').trim();
          const r = await call('act', { action: 'select', handle: target.handle, option });
          if (r?.result === 'no-option') return { ok: false, note: `沒有「${option}」這個選項${r.options?.length ? `（有：${r.options.join('、')}）` : ''}` };
          return outcome(r, ref);
        }
        case 'wait':
          await sleep(Math.max(100, Math.min(3000, Number(args.ms) || 1000)));
          return { ok: true };
        default:
          return { ok: false, note: `沒有 ${call_.tool} 這個工具` };
      }
    },

    extra: {
      tools: MAC_APP_TOOLS,
      async run(call_) {
        const args = call_.args ?? {};
        if (call_.tool === 'menu') {
          const path = pathOf(args.path);
          if (!path.length) return { ok: false, note: '要給選單的名字' };
          const r = await call('act', { action: 'menu', path });
          if (r?.result === 'no-menu') return { ok: false, note: `選單列裡沒有「${path[r.level ?? 0] ?? path[0]}」${r.options?.length ? `（這一層有：${r.options.join('、')}）` : ''}` };
          return outcome(r, '');
        }
        if (call_.tool === 'open_app') {
          const name = String(args.name ?? '').trim();
          if (!name || !(await openApp(name))) return { ok: false, note: `打不開「${name}」` };
          await sleep(OPEN_SETTLE_MS);
          return { ok: true };
        }
        if (call_.tool === 'open_url') {
          const url = String(args.url ?? '').trim();
          if (!url || !(await openUrl(url))) return { ok: false, note: `打不開「${url}」` };
          await sleep(OPEN_SETTLE_MS);
          return { ok: true };
        }
        return null;
      },
      // 小框寫給人看的：打開「LINE」、選選單「檔案 > 新增視窗」
      describe(call_) {
        const args = call_.args ?? {};
        if (call_.tool === 'menu') return `「${pathOf(args.path).join(' > ')}」`;
        if (call_.tool === 'open_app') return `「${String(args.name ?? '')}」`;
        if (call_.tool === 'open_url') return `「${String(args.url ?? '').replace(/^https?:\/\//, '')}」`;
        return null;
      },
    },

    settle: () => sleep(SETTLE_MS),
  });
  return screen;
}

// 網址沒寫 http 就補 https://（「youtube.com」）
function defaultOpenUrl(raw) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  return new Promise((resolve) => {
    execFile('/usr/bin/open', [url], { timeout: 5000 }, (err) => resolve(!err));
  });
}
