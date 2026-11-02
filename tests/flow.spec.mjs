// 核心的流程（core/flow.mjs、segment.mjs、bubble.mjs）：一段話講完之後怎麼處理、幾句合成一段、小框的階段。
// Mac 小程式、CubeLV、平行沙盒都照這一份；接頭都傳假的進去。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from '../core/index.mjs';

const ed = (mode, text = '', extra = {}) => ({ mode, text, ms: 10, ...extra });

test('判斷：沒有 Jev 就照 AI 整理的判斷，不問人；整理失敗回 failed（照原稿寫）', async () => {
  assert.equal((await core.judgeUtterance({ raw: '打開行事曆', inField: false, edit: async () => ed('command', '', { goal: '打開行事曆' }) })).mode, 'command');
  assert.equal((await core.judgeUtterance({ raw: '幫我整理行程', inField: false, edit: async () => ed('insert', '幫我整理行程。') })).text, '幫我整理行程。');
  assert.deepEqual(await core.judgeUtterance({ raw: 'x', inField: false, edit: async () => { throw new Error('逾時'); } }), { failed: '逾時' });
  // 提早整理作廢：不算失敗
  assert.equal(await core.judgeUtterance({ raw: 'x', inField: false, edit: async () => { throw new Error('aborted'); }, aborted: () => true }), null);
});

test('判斷：游標不在輸入框，AI 說是打字、Jev 很確定是指令（≥ 0.95）才改當指令；不夠確定照 AI', async () => {
  const edits = [];
  const edit = async (t) => { edits.push(t); return t.startsWith('指令，') ? ed('command', '', { goal: '打開 email' }) : ed('insert', '開啟我的 email'); };
  const forced = await core.judgeUtterance({ raw: '開啟我的 email', inField: false, edit, intent: Promise.resolve(0.97) });
  assert.equal(forced.mode, 'command');
  assert.deepEqual(edits, ['開啟我的 email', '指令，開啟我的 email']);
  const kept = await core.judgeUtterance({ raw: '開啟我的 email', inField: false, edit, intent: Promise.resolve(0.9) });
  assert.equal(kept.mode, 'insert');
});

test('判斷：游標在輸入框，AI 說是指令、Jev 看了畫面說不是就當打字；開頭講「指令」照 AI；Jev 確定是指令才改', async () => {
  const no = Promise.resolve({ command: 0.1, named: null, isCommand: false });
  assert.equal(await core.judgeUtterance({ raw: '打開設定', inField: true, edit: async () => ed('command', '', { goal: '打開設定' }), judge: no }), null);
  assert.equal((await core.judgeUtterance({ raw: '指令，打開設定', inField: true, edit: async () => ed('command', '', { goal: '打開設定' }), judge: no })).mode, 'command');
  const yes = Promise.resolve({ command: 0.98, named: null, isCommand: true });
  const edit = async (t) => (t.startsWith('指令，') ? ed('command', '', { goal: '按送出' }) : ed('insert', '按送出'));
  assert.equal((await core.judgeUtterance({ raw: '按送出', inField: true, edit, judge: yes })).mode, 'command');
});

test('整理完要做什麼：指令、刪掉、換回、只有語氣詞不寫、寫字；失敗照原稿寫', () => {
  assert.equal(core.planOutput({ raw: 'x', result: ed('command', '', { goal: 'g' }) }).kind, 'command');
  assert.equal(core.planOutput({ raw: 'x', result: ed('delete_last') }).kind, 'delete_last');
  assert.equal(core.planOutput({ raw: 'x', result: ed('revert_last') }).kind, 'revert_last');
  assert.equal(core.planOutput({ raw: '嗯', result: ed('insert', '') }).kind, 'filler');
  assert.deepEqual(core.planOutput({ raw: '原稿', result: { failed: '逾時' } }), { kind: 'write', text: '原稿', mode: 'insert', ai: false, failed: '逾時' });
  const w = core.planOutput({ raw: '原稿', result: ed('insert', '整理好的。') });
  assert.equal(w.kind, 'write');
  assert.equal(w.text, '整理好的。');
  assert.equal(w.ai, true);
  assert.equal(core.planOutput({ raw: '原稿', result: null }).text, '原稿');
});

test('挑輸入框：上次寫的、只有一個就直接用；拿不準才問決策器；沒有框回 null', async () => {
  const box = (handle, role, label, y) => ({ handle, role, label, x: 0, y, w: 300, h: 40 });
  const asked = [];
  const decider = { available: () => true, engine: () => 'AI', decide: async (state, q) => { asked.push(Object.keys(q)); return { target: { choice: 'e0', confidence: 0.9 } }; } };
  assert.equal((await core.pickTarget({ candidates: [box(1, 'AXTextArea', '訊息', 700)], decider })).choice.handle, 1);
  assert.deepEqual(asked, []);
  const two = [box(1, 'AXTextField', '標題', 100), box(2, 'AXTextArea', '輸入訊息', 700)];
  assert.equal((await core.pickTarget({ candidates: two, window: { x: 0, y: 0, w: 400, h: 800 }, decider })).choice.handle, 1);
  assert.equal(asked.length, 1);
  assert.equal((await core.pickTarget({ candidates: two, window: { x: 0, y: 0, w: 400, h: 800 } })).choice.handle, 2);
  assert.equal(await core.pickTarget({ candidates: [] }), null);
});

test('挑輸入框：App 標了 outbound（一按送出就給別人）的框不自動挑，就算只有它、或上次寫過它', async () => {
  const box = (handle, role, label, y, extra = {}) => ({ handle, role, label, x: 0, y, w: 300, h: 40, ...extra });
  const reply = box(1, 'AXTextArea', '回覆', 700, { outbound: true });
  assert.equal(await core.pickTarget({ candidates: [reply] }), null);
  assert.equal(await core.pickTarget({ candidates: [reply], remembered: { role: 'AXTextArea', label: '回覆', frame: { y: 700 } } }), null);
  const note = box(2, 'AXTextArea', '內文', 300);
  assert.equal((await core.pickTarget({ candidates: [reply, note] })).choice.handle, 2);
});

test('去某個地方：開了 navigate，「打開／進到／去」開頭的短句 AI 判成打字就不寫；沒開照舊寫字', () => {
  assert.deepEqual(core.navigationIntent('打開隨手記'), { verb: '打開', target: '隨手記' });
  assert.deepEqual(core.navigationIntent('進到我的市集。'), { verb: '進到', target: '市集' });
  assert.deepEqual(core.navigationIntent('Open settings'), { verb: 'Open', target: 'settings' });
  assert.equal(core.navigationIntent('去年營收成長多少'), null);
  assert.equal(core.navigationIntent('去吃飯了'), null);
  assert.equal(core.navigationIntent('明天四點開會記得帶筆電'), null);
  assert.equal(core.navigationIntent('打開之後幫我把上週的三份報告整理成一份給老闆看'), null);
  assert.deepEqual(core.planOutput({ raw: '打開手機', result: ed('insert', '打開手機。'), navigate: true }), { kind: 'navigate', target: '手機', text: '打開手機' });
  assert.equal(core.planOutput({ raw: '打開手機', result: { failed: '逾時' }, navigate: true }).kind, 'navigate');
  assert.equal(core.planOutput({ raw: '打開手機', result: ed('insert', '打開手機。') }).kind, 'write');
  assert.equal(core.planOutput({ raw: '打開市集', result: ed('command', '', { goal: '打開市集' }), navigate: true }).kind, 'command');
  assert.equal(core.planOutput({ raw: '去年營收成長多少', result: ed('insert', '去年營收成長多少？'), navigate: true }).kind, 'write');
});

test('幾句合成一段：停滿 pauseMs 才交出去；提早整理好、停了 pasteAfterMs 就交出去並帶著整理結果；又開口就作廢', async () => {
  let clock = 0;
  const s = { speaking: false, busy: false, lastVoiceAt: 0 };
  const segments = [];
  const prepared = [];
  const seg = core.createSegmenter({
    pauseMs: 1800, pasteAfterMs: 1200, state: () => s, now: () => clock,
    prepare: async (raw, signal) => { prepared.push({ raw, signal }); return `整理：${raw}`; },
    onSegment: (x) => segments.push(x),
    setTimer: () => 1, clearTimer: () => {},
  });
  seg.add('幫我整理');
  seg.add('這週的行程');
  clock = 100;
  seg.check(); // 開始提早整理
  assert.equal(seg.working(), '幫我整理這週的行程');
  await new Promise((r) => setTimeout(r, 0));
  // 又開口：作廢
  s.speaking = true;
  seg.check();
  assert.equal(prepared[0].signal.aborted, true);
  assert.equal(seg.working(), null);
  s.speaking = false;
  s.lastVoiceAt = 1000;
  clock = 1100;
  seg.check(); // 再提早整理一次
  await new Promise((r) => setTimeout(r, 0));
  clock = 2300; // 停了 1.3 秒，整理好了
  seg.check();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].raw, '幫我整理這週的行程');
  assert.equal(await segments[0].prepared, '整理：幫我整理這週的行程');
  assert.equal(seg.has(), false);
  // 不提早：停滿 pauseMs 才交
  const late = [];
  const plain = core.createSegmenter({ pauseMs: 1800, pasteAfterMs: 0, state: () => s, now: () => clock, onSegment: (x) => late.push(x) });
  plain.add('好');
  s.lastVoiceAt = clock;
  clock += 1000;
  plain.check();
  assert.equal(late.length, 0);
  clock += 900;
  plain.check();
  assert.equal(late.length, 1);
  assert.equal(late[0].prepared, null);
  // force：不等安靜
  plain.add('暫停前講的');
  plain.force();
  plain.check();
  assert.equal(late.length, 2);
});

test('講話中的小框（Mac、CubeLV 同一個 speechBubble）：預設一開口就跟著出字；confirmedOnly（CubeLV 一直聽）確認是你講的才跳', () => {
  const b = core.speechBubble;
  // 預設：一開口就出，預覽跟著跑；講話中不標是誰，講完才標；停一下先整理照常出
  assert.deepEqual(b({ heard: '', live: '', speaking: true }), { state: 'hearing', text: '', speaker: '' });
  assert.deepEqual(b({ heard: '', live: '打開台積', speaking: true, speaker: 'mine' }), { state: 'hearing', text: '打開台積', speaker: '' });
  assert.deepEqual(b({ heard: '打開台積電', live: '打開台積電的個股', speaking: false, speaker: 'mine' }), { state: 'hearing', text: '打開台積電的個股', speaker: 'mine' });
  assert.deepEqual(b({ heard: '打開台積電的個股資訊頁', live: '打開台積', speaking: false }), { state: 'hearing', text: '打開台積電的個股資訊頁', speaker: '' });
  assert.equal(b({ heard: '', live: '', speaking: false }), null);
  assert.deepEqual(b({ heard: '打開市集', working: '打開市集', speaking: false }), { state: 'working', text: '打開市集', speaker: '' });
  // 預設：別人講的說「別人在講話」，附上預覽聽到的字
  assert.deepEqual(b({ ignored: '今天晚餐吃什麼', speaking: false }), { state: 'ignored', text: '今天晚餐吃什麼', speaker: '' });
  // confirmedOnly：這段還沒有句子確認是你講的，誰在講都不跳；別人講的也不跳
  const only = (input) => b({ ...input, confirmedOnly: true });
  assert.equal(only({ heard: '', live: '旁邊的人在聊天', lastMine: true, speaking: true }), null);
  assert.equal(only({ heard: '', ignored: '今天晚餐吃什麼', lastMine: false }), null);
  // confirmedOnly：有一句轉好了才出來，上一句是你的才帶預覽，講話中就標是誰
  assert.deepEqual(only({ heard: '打開台積電', live: '打開台積電的個股資訊頁', lastMine: true, speaking: true, speaker: 'mine' }), { state: 'hearing', text: '打開台積電的個股資訊頁', speaker: 'mine' });
  assert.deepEqual(only({ heard: '打開台積電', live: '打開台積電今天晚餐吃什麼', lastMine: false, speaking: true }), { state: 'hearing', text: '打開台積電', speaker: '' });
  assert.deepEqual(only({ heard: '打開市集', working: '打開市集', speaking: false }), { state: 'working', text: '打開市集', speaker: '' });
});

test('小框：每個階段的標題、內文、顏色、停多久；三種語言；聲紋還在背景學不標也不說還要講多久；太長只留最後的字', () => {
  assert.deepEqual(core.bubbleContent({ state: 'hearing' }, 'zh'), { title: '聽著…', body: '', tone: 'blue', loud: false, busy: false, result: false, holdMs: null });
  assert.equal(core.bubbleContent({ state: 'hearing', text: '打開' }, 'zh').title, '聽到');
  assert.equal(core.bubbleContent({ state: 'hearing', text: '打開', speaker: 'mine' }, 'zh').title, '你說的');
  const learning = core.bubbleContent({ state: 'hearing', text: '打開', speaker: 'enrolling', enrollSeconds: 6.2 }, 'zh');
  assert.deepEqual([learning.title, learning.body], ['聽到', '打開']);
  assert.equal(core.bubbleContent({ state: 'working', text: 'x' }, 'en').busy, true);
  assert.equal(core.bubbleContent({ state: 'pasted' }, 'ja').title, '貼り付けました');
  assert.equal(core.bubbleContent({ state: 'pasted' }).holdMs, 1400);
  assert.equal(core.bubbleContent({ state: 'done', text: '打開市集' }).holdMs, 700);
  assert.equal(core.bubbleContent({ state: 'command', text: '打開行事曆', detail: '第 1 步：點 按鈕「行事曆」' }, 'zh').body, '打開行事曆\n第 1 步：點 按鈕「行事曆」');
  assert.equal(core.bubbleContent({ state: 'failed', text: 'g', detail: '找不到' }).loud, true);
  assert.equal(core.bubbleContent({ state: 'nofield', detail: '複製上一句' }, 'zh').body, '複製上一句');
  assert.equal(core.bubbleContent({ state: 'noplace', text: '打開手機' }, 'zh').title, '找不到這個頁面');
  assert.equal(core.bubbleContent({ state: 'noplace', text: '打開手機' }, 'zh').body, '打開手機');
  assert.equal(core.bubbleContent({ state: 'error', text: 'x' }).tone, 'red');
  assert.equal(core.bubbleContent({ state: 'hide' }), null);
  assert.equal(core.bubbleContent({ state: 'hearing', text: '字'.repeat(100) }).body.length, 85);
  assert.equal(core.stepText({ n: 2, action: 'click', target: '按鈕「行事曆」（上左）' }, 'zh'), '第 2 步：點 按鈕「行事曆」（上左）');
  assert.equal(core.stepText({ n: 1, action: 'press_key', target: 'Enter' }, 'en'), 'Step 1: press Enter');
  assert.equal(core.stepText({ n: 3, action: 'open_app', target: '「LINE」' }, 'zh'), '第 3 步：打開「LINE」');
});
