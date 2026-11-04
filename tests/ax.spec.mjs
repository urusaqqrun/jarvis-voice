// AX 小幫手對真的視窗：開 tests/fixtures/test-window.js（不搶前景），讀上下文、找輸入框、對焦、列元件；操作代理讀結構樹、動手。
// 不送任何按鍵：測試視窗不在最前面，貼上要回 not-front，填字改成直接設值。跑測試的程式沒有「輔助使用」權限就跳過。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createAx } from '../bin/ax.mjs';
import { createMacAgentScreen } from '../bin/agent-screen.mjs';
import { runAgent } from '../core/agent.mjs';
import { ownKeyService } from '../core/providers.mjs';
import { readingOrder } from '../core/ocr.mjs';
import { bringToFront, holdFront, restoreFront, sendToBack } from './fixtures/front.mjs';

const ax = createAx();
after(() => ax.close());

const trusted = process.platform === 'darwin' && (await ax.call('check', { ask: false }).catch(() => ({}))).trusted;

test('AX 小幫手：讀上下文、找輸入框、對焦、列元件；不在前景不貼', { skip: !trusted && '沒有輔助使用權限', timeout: 30_000 }, async () => {
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(import.meta.dirname, 'fixtures', 'test-window.js')], { stdio: 'ignore' });
  try {
    const pid = win.pid;
    let ctx;
    for (let i = 0; i < 40; i += 1) {
      ctx = await ax.call('context', { pid, chars: 400 }).catch(() => null);
      if (ctx?.field?.editable) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(ctx.window, 'JarvisVoice 測試視窗');
    assert.ok(await sendToBack(pid), '測試視窗要在背景');
    assert.deepEqual([ctx.field.role, ctx.field.label, ctx.field.before, ctx.field.after], ['AXTextArea', '訊息', '今天的待辦：', '']);
    const withScreen = await ax.call('context', { pid, screen: 1500 });
    assert.match(withScreen.screen, /畫面文字：我們在討論 JarvisVoice/);
    assert.doesNotMatch(withScreen.screen, /今天的待辦/); // 輸入框裡的字不算

    const found = await ax.call('targets', { pid });
    const byLabel = Object.fromEntries(found.candidates.map((c) => [c.label, c]));
    assert.equal(byLabel['搜尋'].subrole, 'AXSearchField');
    assert.equal(byLabel['密碼'].subrole, 'AXSecureTextField');
    assert.equal(byLabel['訊息'].focused, true);

    assert.equal((await ax.call('focus', { handle: byLabel['主旨'].handle })).ok, true);
    const moved = await ax.call('context', { pid });
    assert.equal(moved.field.label, '主旨');

    await ax.call('focus', { handle: byLabel['密碼'].handle });
    const secret = await ax.call('context', { pid });
    assert.equal(secret.field.secure, true);

    assert.equal((await ax.call('read', { handle: byLabel['訊息'].handle })).value, '今天的待辦：');
    const { elements } = await ax.call('elements', { pid });
    assert.deepEqual(elements.map((e) => e.label), ['搜尋', '主旨', '密碼', '訊息']);

    await ax.call('focus', { handle: byLabel['訊息'].handle });
    assert.equal((await ax.call('paste', { pid, text: '不該貼出去' })).result, 'not-front');
    assert.equal((await ax.call('replace', { pid, old: '不在這裡', text: '' })).result, 'mismatch');
    // 不在前景時填字是直接設值，不送按鍵
    assert.equal((await ax.call('act', { pid, handle: byLabel['主旨'].handle, action: 'fill', text: '週會改期' })).result, 'ok');
    assert.equal((await ax.call('read', { handle: byLabel['主旨'].handle })).value, '週會改期');
  } finally {
    win.kill();
  }
});

test('讀不到畫面時截圖認字：認出視窗上的字和位置（要螢幕錄影權限）', { skip: !trusted && '沒有輔助使用權限', timeout: 30_000 }, async () => {
  const win = await openStockWindow();
  try {
    // 視窗剛開可能還沒畫完：最多試 5 次
    let seen;
    let labels = [];
    for (let i = 0; i < 5; i += 1) {
      seen = await ax.call('ocr', { pid: win.pid, ask: false }, 15000);
      if (!seen.permission) return; // 跑測試的程式沒有螢幕錄影權限就略過
      labels = seen.items.map((x) => x.text);
      if (labels.some((t) => t.includes('設定'))) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.ok(labels.some((t) => t.includes('設定')), labels.join('|'));
    // 順序由核心排（由上往下、由左往右），跟平行沙盒同一套
    assert.deepEqual(seen.items.map((x) => x.text), readingOrder(seen.items).map((x) => x.text));
    const both = await ax.call('elements', { pid: win.pid, ocr: 'always' }, 15000);
    assert.equal(both.source, 'ocr');
    assert.ok(both.elements.some((e) => e.ocr && e.label.includes('自選股')), '視窗標題是讀不到的元件，要列進來');
    assert.ok(!both.elements.some((e) => e.ocr && e.label === '設定'), '按鈕上的字已經有元件了，不重複列');
  } finally {
    win.kill();
  }
});

async function openStockWindow() {
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(import.meta.dirname, 'fixtures', 'stock-window.js')], { stdio: 'ignore' });
  for (let i = 0; i < 40; i += 1) {
    const r = await ax.call('elements', { pid: win.pid }).catch(() => null);
    if (r?.elements?.length) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  assert.ok(await sendToBack(win.pid), '看盤測試視窗要在背景');
  return win;
}

const title = async (pid) => (await ax.call('elements', { pid })).window.title;

// 照劇本回的 AI：每一步在結構樹裡找名字對得上的編號
function scriptedAi(plan) {
  const seen = [];
  return {
    seen,
    async complete({ user }) {
      seen.push(user);
      const next = plan[Math.min(seen.length - 1, plan.length - 1)];
      const ref = next.name ? user.match(new RegExp(`\\[(e\\d+)\\][^\\n]*「${next.name}」`))?.[1] : undefined;
      return JSON.stringify({ tool: next.tool, args: { ...(ref ? { ref } : {}), ...(next.args ?? {}) }, why: '' });
    },
  };
}

test('操作代理對真的視窗（背景、不送按鍵）：讀結構樹 → 填字 → Enter（搜尋框確認）→ 點結果；選單列對不到說那一層有什麼', { skip: !trusted && '沒有輔助使用權限', timeout: 30_000 }, async () => {
  const win = await openStockWindow();
  try {
    const screen = createMacAgentScreen({ ax, frontApp: async () => ({ pid: win.pid }), openApp: async () => false });
    const first = await screen.snapshot();
    assert.match(first.text, /\[e\d+\] 按鈕「刪除自選」/, '畫面上的按鈕都要給 AI 看');
    assert.match(first.text, /\[e\d+\] 輸入框「搜尋股票」（搜尋框/);
    assert.match(first.text, /選單列（用 menu 選裡面的項目）：.*編輯/);
    assert.match((await screen.run({ tool: 'menu', args: { path: ['編輯', '不存在的項目'] }, why: '' })).note, /這一層有：貼上、全選/);
    const ai = scriptedAi([
      { tool: 'fill', name: '搜尋股票', args: { text: '台積電' } },
      { tool: 'press_key', name: '搜尋股票', args: { key: 'Enter' } },
      { tool: 'click', name: '台積電 2330' },
      { tool: 'done', args: { summary: '個股頁' } },
    ]);
    const result = await runAgent({ screen, complete: ai.complete, goal: '打開台積電（2330）的個股頁', context: { app: '看盤' } });
    assert.equal(result.ok, true, result.reason);
    assert.equal(await title(win.pid), '台積電 2330 個股');
    assert.match(ai.seen[2], /\[e\d+\] 按鈕「台積電 2330」/, '搜尋完的結果要讀得到');
  } finally {
    win.kill();
  }
});

// 有 OPENAI_API_KEY 才跑：真的 AI 每一步看結構樹挑工具
test('操作代理 + 真的 AI', { skip: (!trusted && '沒有輔助使用權限') || (!process.env.OPENAI_API_KEY && '沒有 OPENAI_API_KEY'), timeout: 120_000 }, async () => {
  const win = await openStockWindow();
  try {
    const { complete } = ownKeyService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY, timeoutMs: 20000 });
    const run = (goal) => runAgent({ screen: createMacAgentScreen({ ax, frontApp: async () => ({ pid: win.pid }), openApp: async () => false }), complete, goal, context: { app: '看盤' } });
    assert.equal((await run('打開台積電（2330）的個股頁')).ok, true);
    assert.equal(await title(win.pid), '台積電 2330 個股');
    assert.equal((await run('打開設定頁')).ok, true);
    assert.equal(await title(win.pid), '設定');
  } finally {
    win.kill();
  }
});

// 會搶前景約 2 秒，要 VOICE_DICTATION_FOCUS_TESTS=1 才跑：測試視窗到最前面時真的貼得進去、換得回來
test('貼上與換回原文（測試視窗在最前面）', {
  skip: (!trusted && '沒有輔助使用權限') || (!process.env.VOICE_DICTATION_FOCUS_TESTS && '會搶前景，要 VOICE_DICTATION_FOCUS_TESTS=1'),
  timeout: 30_000,
}, async () => {
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(import.meta.dirname, 'fixtures', 'test-window.js'), '--empty'], { stdio: 'ignore' });
  try {
    const pid = win.pid;
    for (let i = 0; i < 40; i += 1) {
      const ctx = await ax.call('context', { pid }).catch(() => null);
      if (ctx?.field?.editable) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(await holdFront(pid), '測試視窗要到最前面');
    const pasted = await ax.call('paste', { pid, text: '我們明天四點開會。' });
    assert.equal(pasted.result, 'ok');
    await new Promise((r) => setTimeout(r, 300));
    const { handle } = (await ax.call('context', { pid })).field;
    assert.equal((await ax.call('read', { handle })).value, '我們明天四點開會。');
    assert.equal((await ax.call('replace', { pid, old: '我們明天四點開會。', text: '嗯我們明天三點不對四點開會。' })).result, 'ok');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await ax.call('read', { handle })).value, '嗯我們明天三點不對四點開會。');
    assert.equal((await ax.call('replace', { pid, old: '嗯我們明天三點不對四點開會。', text: '' })).result, 'ok');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await ax.call('read', { handle })).value, '');
    // 操作代理的按鍵：在最前面才送，組合鍵、認不得的鍵
    const { candidates } = await ax.call('targets', { pid });
    const subject = candidates.find((c) => c.label === '主旨');
    assert.equal((await ax.call('act', { pid, handle: subject.handle, action: 'key', key: 'cmd+a' })).result, 'ok');
    assert.equal((await ax.call('act', { pid, action: 'key', key: '不存在的鍵' })).result, 'unknown-key');
  } finally {
    win.kill();
    restoreFront();
  }
});

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 框裡現在的字（游標前後）
async function fieldText(pid) {
  const { field } = await ax.call('context', { pid, chars: 400 });
  return `${field.before ?? ''}${field.selected ?? ''}${field.after ?? ''}`;
}

// 等框裡變成 want（貼上是 Cmd+V，app 晚一點才讀剪貼簿）
async function waitText(pid, want) {
  let text = '';
  for (let i = 0; i < 30; i += 1) {
    text = await fieldText(pid);
    if (text === want) return text;
    await sleep(100);
  }
  return text;
}

// 草稿的一整輪：先貼、接著貼、換字、選取了字不寫、按送出之後不換
async function draftRound(pid) {
  const first = await ax.call('draft', { pid, text: '嗯第一句 hello. ', expect: '' });
  assert.deepEqual([first.result, first.continued, first.before], ['ok', true, '']);
  assert.equal(await waitText(pid, '嗯第一句 hello. '), '嗯第一句 hello. ');
  const second = await ax.call('draft', { pid, text: '第二句。', expect: '嗯第一句 hello. ' });
  assert.deepEqual([second.result, second.continued, second.before], ['ok', true, '嗯第一句 hello. ']);
  assert.equal((await ax.call('replace', { pid, old: '嗯第一句 hello. 第二句。', text: '第一句 hello，第二句。' })).result, 'ok');
  assert.equal(await waitText(pid, '第一句 hello，第二句。'), '第一句 hello，第二句。');
  // 換完游標還在最後面：下一句接得上
  const third = await ax.call('draft', { pid, text: '第三句', expect: '第一句 hello，第二句。' });
  assert.deepEqual([third.result, third.continued], ['ok', true]);
  assert.equal(await waitText(pid, '第一句 hello，第二句。第三句'), '第一句 hello，第二句。第三句');
  // 上一段還在整理又多寫了一段：連後面的一起換，換完游標還在最後面
  assert.equal((await ax.call('replace', { pid, old: '第二句。第三句', text: '第二句！第三句' })).result, 'ok');
  assert.equal(await waitText(pid, '第一句 hello，第二句！第三句'), '第一句 hello，第二句！第三句');
  // 選取了字（又講話可能是要改寫）不寫
  assert.equal((await ax.call('act', { pid, action: 'key', key: 'cmd+a' })).result, 'ok');
  await sleep(200);
  assert.equal((await ax.call('draft', { pid, text: '不該出現', expect: '' })).result, 'has-selection');
  assert.equal((await ax.call('act', { pid, action: 'key', key: 'right' })).result, 'ok');
  await sleep(200);
  // 自己接著打字：游標前面不是草稿，不換
  assert.equal((await ax.call('replace', { pid, old: '第二句', text: '不該換' })).result, 'mismatch');
  // 按送出（框清空）：不換，框裡不會多出字；下一句從空的框開始
  assert.equal((await ax.call('act', { pid, action: 'key', key: 'Enter' })).result, 'ok');
  assert.equal(await waitText(pid, ''), '');
  assert.equal((await ax.call('replace', { pid, old: '第三句', text: '第三句。' })).result, 'mismatch');
  await sleep(600);
  assert.equal(await fieldText(pid), '');
  const next = await ax.call('draft', { pid, text: '新的一句', expect: '第三句' });
  assert.deepEqual([next.result, next.continued, next.before], ['ok', false, '']);
  assert.equal(await waitText(pid, '新的一句'), '新的一句');
  assert.equal((await ax.call('act', { pid, action: 'key', key: 'Enter' })).result, 'ok');
  assert.equal(await waitText(pid, ''), '');
}

// 開獨立的 Chrome（自己的設定資料夾，不碰平常用的）：Claude 桌面版、Chrome 的輸入框都是這個引擎，輔助使用資訊又晚一點才更新。
// 會搶前景約 5 秒，要 VOICE_DICTATION_FOCUS_TESTS=1 才跑
test('草稿：真的網頁輸入框（textarea、contenteditable）先貼、換字、送出後不換', {
  skip: (!trusted && '沒有輔助使用權限') || (!process.env.VOICE_DICTATION_FOCUS_TESTS && '會搶前景，要 VOICE_DICTATION_FOCUS_TESTS=1') || (!existsSync(CHROME) && '沒有 Chrome'),
  timeout: 60_000,
}, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'jarvis-voice-chrome-'));
  const page = `file://${join(import.meta.dirname, 'fixtures', 'draft-field.html')}`;
  const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--force-renderer-accessibility', `--app=${page}`], { stdio: 'ignore' });
  try {
    const pid = chrome.pid;
    let ready = null;
    for (let i = 0; i < 100 && !ready?.field?.editable; i += 1) {
      await sleep(150);
      ready = await ax.call('context', { pid }).catch(() => null);
    }
    assert.ok(ready?.field?.editable, '獨立的 Chrome 要開好、游標在輸入框');
    assert.ok(await holdFront(pid), '要到最前面');
    await draftRound(pid);
    const { candidates } = await ax.call('targets', { pid });
    const rich = candidates.find((c) => c.label === '網頁編輯器');
    assert.ok(rich, '要找得到網頁編輯器');
    await ax.call('focus', { handle: rich.handle });
    await sleep(200);
    await draftRound(pid);
  } finally {
    chrome.kill();
    restoreFront();
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  }
});

// 原生的文字框（NSTextView）。會搶前景約 2 秒，要 VOICE_DICTATION_FOCUS_TESTS=1 才跑
test('草稿：原生文字框先貼、換字；清空後不換', {
  skip: (!trusted && '沒有輔助使用權限') || (!process.env.VOICE_DICTATION_FOCUS_TESTS && '會搶前景，要 VOICE_DICTATION_FOCUS_TESTS=1'),
  timeout: 30_000,
}, async () => {
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(import.meta.dirname, 'fixtures', 'test-window.js'), '--empty'], { stdio: 'ignore' });
  try {
    const pid = win.pid;
    let ctx = null;
    for (let i = 0; i < 40 && !ctx?.field?.editable; i += 1) {
      ctx = await ax.call('context', { pid }).catch(() => null);
      if (!ctx?.field?.editable) await sleep(150);
    }
    assert.ok(await holdFront(pid), '測試視窗要到最前面');
    const first = await ax.call('draft', { pid, text: '嗯我們四點開會', expect: '' });
    assert.deepEqual([first.result, first.continued, first.before], ['ok', true, '']);
    assert.equal(await waitText(pid, '嗯我們四點開會'), '嗯我們四點開會');
    assert.equal((await ax.call('replace', { pid, old: '嗯我們四點開會', text: '我們四點開會。' })).result, 'ok');
    assert.equal(await waitText(pid, '我們四點開會。'), '我們四點開會。');
    assert.equal((await ax.call('act', { pid, action: 'key', key: 'cmd+a' })).result, 'ok');
    assert.equal((await ax.call('act', { pid, action: 'key', key: 'backspace' })).result, 'ok');
    assert.equal(await waitText(pid, ''), '');
    assert.equal((await ax.call('replace', { pid, old: '我們四點開會。', text: '不該出現' })).result, 'mismatch');
    await sleep(500);
    assert.equal(await fieldText(pid), '');
  } finally {
    win.kill();
    restoreFront();
  }
});

test('草稿：不在前景不寫', { skip: !trusted && '沒有輔助使用權限', timeout: 30_000 }, async () => {
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(import.meta.dirname, 'fixtures', 'test-window.js'), '--empty'], { stdio: 'ignore' });
  try {
    const pid = win.pid;
    let ctx = null;
    for (let i = 0; i < 40 && !ctx?.field?.editable; i += 1) {
      ctx = await ax.call('context', { pid }).catch(() => null);
      if (!ctx?.field?.editable) await sleep(150);
    }
    assert.ok(await sendToBack(pid), '測試視窗要在背景');
    assert.equal((await ax.call('draft', { pid, text: '不該出現', expect: '' })).result, 'not-front');
    assert.equal(await fieldText(pid), '');
  } finally {
    win.kill();
  }
});
