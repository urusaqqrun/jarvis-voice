// 第二、三層的零件測試：AI 整理（三家）、設定、找輸入框、Jev 決策、指令（Mac 的操作代理接頭）、自動學詞、整條管線（音檔 → 轉寫 → 整理）。
// 雲端服務都用本機假伺服器。node --test tests/*.spec.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'voice-dictation-ai-test-'));
process.env.VOICE_DICTATION_STATE_DIR = stateDir;

const { buildPrompt, parseResult, editSegment } = await import('../bin/editor.mjs');
const { loadConfig, aiKey, styleFor } = await import('../bin/config.mjs');
const { rankTargets } = await import('../bin/targeter.mjs');
const { createDecider, fieldQuestions } = await import('../bin/decide.mjs');
const { createMacAgentScreen, treeNodes, treeHeader } = await import('../bin/agent-screen.mjs');
const { writeTree } = await import('../core/agentScreen.mjs');
const { runAgent } = await import('../core/agent.mjs');
const { extractEdited, replacedChunks } = await import('../bin/learn.mjs');
const { createVocabAuto, splitVocabulary, plausibleTerm, AUTO_HEADER } = await import('../bin/vocab-auto.mjs');
const { wavFromPcm16 } = await import('../bin/engines/batch.mjs');

// 假伺服器：handler(請求 JSON, 第幾次, headers) → { status, body }
async function fakeJson(handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const isJson = (req.headers['content-type'] ?? '').includes('json');
    const call = { headers: req.headers, url: req.url, body: isJson ? JSON.parse(raw.toString()) : null, raw };
    calls.push(call);
    const { status = 200, body } = await handler(call, calls.length);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const chatReply = (obj) => ({ body: { choices: [{ message: { content: JSON.stringify(obj) } }] } });

test('AI 整理的提示：上下文都放進去、游標欄位一定有；開指令模式才有 command 規則', () => {
  const { system, user } = buildPrompt({
    transcript: '嗯明天四點',
    context: { app: 'Slack', bundle: 'com.tinyspeck.slackmacgap', window: 'Jason', url: '', field: { label: '訊息', role: 'AXTextArea', before: '好，', after: '', selected: '' } },
    style: '口語', vocabulary: ['CubeLV', '平行沙盒'],
  });
  assert.match(system, /<vocabulary>\nCubeLV\n平行沙盒\n<\/vocabulary>/);
  assert.doesNotMatch(system, /- command：/);
  assert.match(user, /<app>Slack（com.tinyspeck.slackmacgap）（只是使用者正在打字的地方/);
  assert.match(user, /<field>訊息，AXTextArea<\/field>/);
  assert.match(user, /<before>好，<\/before>/);
  assert.match(user, /<style>口語<\/style>/);
  assert.match(user, /<transcript>嗯明天四點<\/transcript>$/);
  assert.doesNotMatch(user, /<after>/);
  const empty = buildPrompt({ transcript: '打開設定', commands: true });
  assert.match(empty.system, /- command：/);
  assert.match(empty.user, /<field><\/field>/);
});

test('AI 回的 JSON：格式不對、改寫選取卻給空字、沒開指令模式卻回 command，都當沒回；insert 空字＝只有語氣詞不用寫', () => {
  assert.deepEqual(parseResult('{"mode":"insert","text":"好"}'), { mode: 'insert', text: '好' });
  assert.deepEqual(parseResult('前言 {"mode":"delete_last","text":"x"} 後記'), { mode: 'delete_last', text: '' });
  assert.deepEqual(parseResult('{"mode":"insert","text":""}'), { mode: 'insert', text: '' });
  assert.equal(parseResult('{"mode":"replace_selection","text":" "}'), null);
  assert.equal(parseResult('{"mode":"answer","text":"2"}'), null);
  assert.equal(parseResult('不是 JSON'), null);
  const command = '{"mode":"command","text":"台積電","goal":"打開台積電個股頁","app":""}';
  assert.equal(parseResult(command), null);
  assert.deepEqual(parseResult(command, { commands: true }), { mode: 'command', text: '台積電', goal: '打開台積電個股頁', app: '', message: '' });
  assert.equal(parseResult('{"mode":"command","text":"","goal":" ","app":""}', { commands: true }), null);
});

test('三家 AI：OpenAI 用 json_schema 並關推理、DeepSeek 關 thinking 用 json_object、Claude 關 thinking', async () => {
  const server = await fakeJson((call) => {
    if (call.url.includes('messages')) return { body: { content: [{ type: 'text', text: '{"mode":"insert","text":"Claude 版"}' }] } };
    return chatReply({ mode: 'insert', text: call.body.model.startsWith('deepseek') ? 'DeepSeek 版' : 'OpenAI 版', goal: '', app: '' });
  });
  process.env.VOICE_DICTATION_OPENAI_CHAT_URL = `${server.url}/openai`;
  process.env.VOICE_DICTATION_DEEPSEEK_URL = `${server.url}/deepseek`;
  process.env.VOICE_DICTATION_ANTHROPIC_URL = `${server.url}/messages`;
  try {
    const input = { transcript: '嗯好', context: {}, vocabulary: [] };
    const openai = await editSegment({ provider: 'openai', apiKey: 'sk-o', ...input });
    const deepseek = await editSegment({ provider: 'deepseek', apiKey: 'sk-d', ...input });
    const claude = await editSegment({ provider: 'claude', apiKey: 'sk-c', ...input });
    assert.deepEqual([openai.text, deepseek.text, claude.text], ['OpenAI 版', 'DeepSeek 版', 'Claude 版']);
    const [o, d, c] = server.calls;
    assert.equal(o.headers.authorization, 'Bearer sk-o');
    assert.equal(o.body.model, 'gpt-6-luna');
    assert.equal(o.body.reasoning_effort, 'none');
    assert.equal(o.body.response_format.type, 'json_schema');
    assert.equal(d.headers.authorization, 'Bearer sk-d');
    assert.equal(d.body.model, 'deepseek-flash');
    assert.deepEqual(d.body.thinking, { type: 'disabled' });
    assert.equal(d.body.response_format.type, 'json_object');
    assert.equal(c.headers['x-api-key'], 'sk-c');
    assert.equal(c.body.model, 'claude-haiku-5-5');
    assert.deepEqual(c.body.thinking, { type: 'disabled' });
    await assert.rejects(editSegment({ provider: 'deepseek', apiKey: '', ...input }), /沒有 DeepSeek API key/);
  } finally {
    server.close();
  }
});

test('設定：AI 各家的 key 從 keys／keyFiles／keyCommands／環境變數拿，OpenAI 沿用轉寫的 key；語氣網域優先', () => {
  writeFileSync(join(stateDir, 'ds.env'), 'export DEEPSEEK_API_KEY=sk-ds\n');
  writeFileSync(join(stateDir, 'jev.txt'), 'ts-key\n');
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    engine: 'openai', openai: { apiKey: 'sk-openai' },
    ai: { enabled: true, keyFiles: { deepseek: join(stateDir, 'ds.env') }, keys: { claude: 'sk-claude' }, styles: { 'com.example': '自訂' } },
    jev: { apiKeyFile: join(stateDir, 'jev.txt') },
  }));
  const { config, error } = loadConfig();
  assert.equal(error, '');
  assert.equal(config.ai.provider, 'deepseek');
  assert.equal(aiKey(config), 'sk-ds');
  assert.equal(aiKey(config, 'claude'), 'sk-claude');
  assert.equal(aiKey(config, 'openai'), 'sk-openai');
  assert.equal(config.jev.apiKey, 'ts-key');
  assert.equal(config.ai.enabled, true); // 三層預設都開
  assert.equal(config.autoFocus, true);
  assert.equal(config.commands, true);
  assert.match(styleFor(config, 'com.google.Chrome', 'https://mail.google.com/mail/u/0'), /email/);
  assert.match(styleFor(config, 'com.tinyspeck.slackmacgap', ''), /聊天/);
  assert.equal(styleFor(config, 'com.example', ''), '自訂');
  assert.equal(styleFor(config, 'com.unknown', 'not a url'), '');
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    ai: { keyCommands: { claude: 'echo sk-from-command' } }, jev: { apiKeyCommand: 'printf ts-cmd' },
  }));
  const viaCommand = loadConfig().config;
  assert.equal(aiKey(viaCommand, 'claude'), 'sk-from-command');
  assert.equal(viaCommand.jev.apiKey, 'ts-cmd');
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ engine: 'openai', openai: { apiKey: 'sk-only-openai' } }));
  const onlyOpenai = loadConfig().config;
  assert.equal(onlyOpenai.ai.provider, 'openai'); // 沒指定就用已經有 key 的那家
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ ai: { provider: 'gemini' } }));
  assert.match(loadConfig().error, /ai.provider 只能是/);
});

const testWindow = { x: 200, y: 330, w: 560, h: 452, title: '測試' };
const field = (label, role, y, extra = {}) => ({ handle: y, role, subrole: '', label, x: 219, y, w: 522, h: role === 'AXTextArea' ? 250 : 28, enabled: true, ...extra });

test('找輸入框（沒有決策器時的規則）：所有輸入框都能選；上次寫的優先；只有一個就用；一定挑一個', () => {
  const search = field('搜尋', 'AXTextField', 385, { subrole: 'AXSearchField' });
  const subject = field('主旨', 'AXTextField', 425);
  const secret = field('密碼', 'AXTextField', 465, { subrole: 'AXSecureTextField' });
  const body = field('訊息', 'AXTextArea', 512);
  const all = [search, subject, secret, body];
  const ranked = rankTargets({ candidates: all, window: testWindow });
  assert.equal(ranked.choice.label, '訊息');
  assert.equal(ranked.list.length, 4); // 搜尋框、密碼框也在候選裡，交給決策器挑
  const again = rankTargets({ candidates: all, window: testWindow, remembered: { role: 'AXTextField', label: '主旨' } });
  assert.equal(again.choice.label, '主旨');
  assert.equal(again.sure, true);
  assert.equal(rankTargets({ candidates: [search], window: testWindow }).choice.label, '搜尋');
  const twins = rankTargets({ candidates: [field('A', 'AXTextField', 400), field('B', 'AXTextField', 410)], window: testWindow });
  assert.ok(twins.choice, '分不出高下也要挑一個');
  assert.equal(rankTargets({ candidates: [], window: testWindow }).choice, null);
  assert.equal(rankTargets({ candidates: [{ ...body, enabled: false }, { ...subject, w: 0 }] }).choice, null); // 停用的、看不到的寫不進去
});

test('決策器：有 Jev key 打 /v1/systemone；沒有就把同樣的問題交給 AI，答案不在選項裡的丟掉', async () => {
  const server = await fakeJson((call) => {
    if (call.url.includes('systemone')) {
      return { body: { model: 'jev-1.13.0', answers: { target: { type: 'choice', choice: 'e1', confidence: 0.8, probabilities: { e0: 0.2, e1: 0.8 } } } } };
    }
    return chatReply({ answers: { target: { choice: 'e9', confidence: 0.9 }, extra: { noul: 0.7 } } });
  });
  process.env.VOICE_DICTATION_JEV_URL = `${server.url}/v1/systemone`;
  process.env.VOICE_DICTATION_OPENAI_CHAT_URL = `${server.url}/openai`;
  try {
    const questions = fieldQuestions([field('主旨', 'AXTextField', 425), field('訊息', 'AXTextArea', 512)], testWindow);
    assert.deepEqual(Object.keys(questions.target.criteria), ['e0', 'e1']);
    assert.match(questions.target.criteria.e1, /多行輸入框「訊息」（下中）/);
    const jev = createDecider(() => ({ jevKey: 'ts-1', jevModel: 'jev-latest', ai: { provider: 'openai', apiKey: 'sk' } }));
    assert.equal(jev.engine(), 'Jev');
    const a = await jev.decide({ transcript: '改到四點' }, questions);
    assert.equal(a.target.choice, 'e1');
    const sent = server.calls[0];
    assert.equal(sent.headers.authorization, 'Bearer ts-1');
    assert.equal(sent.body.model, 'jev-latest');
    assert.equal(sent.body.questions.target.type, 'choice');
    assert.deepEqual(Object.keys(sent.body.questions), ['target']);
    assert.deepEqual(sent.body.state, { transcript: '改到四點' });
    const llm = createDecider(() => ({ jevKey: '', ai: { provider: 'openai', apiKey: 'sk' } }));
    assert.equal(llm.engine(), 'AI');
    const b = await llm.decide({ transcript: '改到四點' }, questions);
    assert.equal(b.target, undefined); // e9 不在選項裡
    await assert.rejects(createDecider(() => ({ jevKey: '', ai: null })).decide({}, questions), /做不了決策/);
  } finally {
    server.close();
  }
});

const el = (handle, role, label, y = 100) => ({ handle, role, subrole: '', label, x: 10, y, w: 100, h: 20, focused: false });

// AX 小幫手 tree 回的節點（只填用得到的）
const ctl = (handle, role, name, extra = {}) => ({ depth: 0, kind: 'control', role, subrole: '', name, value: '', off: false, handle, x: 10, y: 100, w: 100, h: 20, ...extra });

test('Mac 操作代理接頭：輔助使用樹寫成跟 CubeLV 一樣的結構樹；選單列寫在最前面', () => {
  const res = {
    app: 'Finder', window: { title: '應用程式' }, menus: ['Finder', '檔案', '編輯'],
    nodes: [
      { depth: 0, kind: 'group', role: 'AXToolbar', subrole: '', name: '' },
      ctl(1, 'AXButton', '返回', { depth: 1, enabled: false }),
      ctl(2, 'AXTextField', '搜尋', { depth: 1, subrole: 'AXSearchField', value: '鴻海', focused: true }),
      { depth: 0, kind: 'scroll', name: '', states: ['下面還有'], handle: 3 },
      { depth: 1, kind: 'group', role: 'AXOutline', subrole: '', name: '側邊欄' },
      ctl(4, 'AXRow', '應用程式', { depth: 2, selected: true }),
      ctl(5, 'AXDisclosureTriangle', '', { depth: 2, expanded: false }),
      ctl(6, 'AXRadioButton', '圖示', { depth: 1, parent: 'AXTabGroup', checked: true }),
      ctl(7, 'AXCheckBox', '顯示隱藏檔', { depth: 1, subrole: 'AXSwitch', checked: true }),
      { depth: 1, kind: 'text', name: '12 個項目' },
      ctl(8, 'AXLink', '說明', { depth: 1, off: true }),
    ],
  };
  const view = writeTree(treeNodes(res), { header: treeHeader(res) });
  assert.deepEqual(view.text.split('\n'), [
    'App：Finder；視窗：應用程式',
    '選單列（用 menu 選裡面的項目）：Finder、檔案、編輯',
    '工具列',
    '  [e1] 按鈕「返回」（不能按）',
    '  [e2] 輸入框「搜尋」，裡面是「鴻海」（搜尋框，游標在這）',
    '[e3] 可捲動區（下面還有）',
    '  清單「側邊欄」',
    '    [e4] 清單項目「應用程式」（選中）',
    '    [e5] 展開鈕「沒有名字」（收起）',
    '  [e6] 分頁「圖示」（選中）',
    '  [e7] 開關「顯示隱藏檔」（勾了）',
    '  「12 個項目」',
    '  [e8] 連結「說明」（畫面外）',
  ]);
});

test('Mac 操作代理接頭：讀不到樹時截圖認出來的字補進沒有名字的列，其他的字列成點位置的「畫面上的字」；圖示認成一個字不算名字', () => {
  const res = {
    app: 'LINE', window: { title: 'LINE' }, menus: [],
    nodes: [
      ctl(1, 'AXTextArea', '', { focused: true, x: 300, y: 700, w: 400, h: 60 }),
      ctl(2, 'AXRow', '', { x: 0, y: 100, w: 250, h: 70 }),
      ctl(3, 'AXRow', '', { x: 0, y: 170, w: 250, h: 70 }),
      ctl(4, 'AXButton', '', { x: 0, y: 20, w: 30, h: 30 }),
    ],
    ocr: { permission: true, items: [
      { text: 'bubu', x: 20, y: 110, w: 60, h: 20 }, { text: '下午 9:30', x: 150, y: 110, w: 60, h: 20 },
      { text: '微波烤箱廢物食堂', x: 20, y: 180, w: 120, h: 20 },
      { text: '①', x: 5, y: 25, w: 20, h: 20 },
      { text: '你好帥', x: 400, y: 400, w: 60, h: 20 },
    ] },
  };
  const nodes = treeNodes(res);
  const text = writeTree(nodes).text;
  assert.match(text, /\[e2\] 清單項目「bubu 下午 9:30」/);
  assert.match(text, /\[e3\] 清單項目「微波烤箱廢物食堂」/);
  assert.match(text, /\[e4\] 按鈕「沒有名字」/);
  assert.match(text, /截圖認出來的字（讀不到結構，點下去是點那個位置）\n  \[e5\] 畫面上的字「你好帥」/);
  assert.deepEqual(nodes.at(-1).target, { at: { x: 430, y: 410 } });
  assert.match(treeHeader({ app: 'LINE', window: {}, ocr: { permission: false, items: [] } }).join('\n'), /螢幕錄影/);
});

// 假的 AX 小幫手：tree 照 page 回，act 記下來、照劇本換頁
function fakeAx(pages, start, onAct) {
  let page = start;
  const acts = [];
  return {
    acts,
    page: () => page,
    go: (next) => { page = next; },
    async call(op, args) {
      if (op === 'tree') return { app: pages[page].app ?? 'AStock', window: { title: page }, menus: ['檔案'], nodes: pages[page].nodes, partial: false, seen: 1, treeMs: 1, ms: 1 };
      if (op === 'act') { acts.push(args); const r = onAct(args, page); if (r?.page) page = r.page; return r?.result ?? { result: 'ok' }; }
      throw new Error(op);
    },
  };
}

// 假 AI：每一步看結構樹，照劇本找編號（name 對得上的那一個）
function scriptedAi(plan) {
  const seen = [];
  return {
    seen,
    async complete({ user }) {
      seen.push(user);
      const next = plan[Math.min(seen.length - 1, plan.length - 1)];
      const ref = next.name ? user.match(new RegExp(`\\[(e\\d+)\\][^\\n]*「${next.name}」`))?.[1] : undefined;
      return JSON.stringify({ tool: next.tool, args: { ...(ref ? { ref } : {}), ...(next.args ?? {}) }, why: next.why ?? '' });
    },
  };
}

test('Mac 操作代理：照 AI 挑的工具做：填字 → 按 Enter → 點結果 → 完成；小框寫畫面上的名字', async () => {
  const pages = {
    自選股: { nodes: [ctl(1, 'AXButton', '刪除自選'), ctl(2, 'AXTextField', '搜尋股票', { subrole: 'AXSearchField' })] },
    搜尋結果: { nodes: [ctl(2, 'AXTextField', '搜尋股票', { subrole: 'AXSearchField', value: '台積電' }), ctl(4, 'AXButton', '台積電 2330'), ctl(5, 'AXButton', '台積電 ADR')] },
    個股: { nodes: [{ depth: 0, kind: 'heading', name: '台積電 2330' }, ctl(6, 'AXLink', '技術分析')] },
  };
  const ax = fakeAx(pages, '自選股', (a) => (a.action === 'key' ? { page: '搜尋結果' } : a.action === 'press' && a.handle === 4 ? { page: '個股' } : null));
  const ai = scriptedAi([
    { tool: 'fill', name: '搜尋股票', args: { text: '台積電' } },
    { tool: 'press_key', name: '搜尋股票', args: { key: 'Enter' } },
    { tool: 'click', name: '台積電 2330' },
    { tool: 'done', args: { summary: '台積電的個股頁' } },
  ]);
  const steps = [];
  const screen = createMacAgentScreen({ ax, frontApp: async () => ({ pid: 42 }), openApp: async () => true });
  screen.settle = async () => {};
  const r = await runAgent({ screen, complete: ai.complete, goal: '打開台積電（2330）的個股頁', context: { app: 'AStock' }, onStep: (s) => steps.push(s) });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(ax.acts.map((a) => [a.action, a.handle, a.text ?? a.key ?? '']), [['fill', 2, '台積電'], ['key', 2, 'Enter'], ['press', 4, '']]);
  assert.ok(ax.acts.every((a) => a.pid === 42));
  assert.match(ai.seen[0], /\[e1\] 按鈕「刪除自選」/, '畫面上的按鈕都要給 AI 看');
  assert.match(ai.seen[0], /選單列（用 menu 選裡面的項目）：檔案/);
  assert.deepEqual(steps.map((s) => [s.action, s.target]), [['fill', '「搜尋股票」：「台積電」'], ['press_key', 'Enter'], ['click', '「台積電 2330」']]);
});

test('傳訊息給某人也走操作代理：切到 LINE → 點截圖認出來的對話 → 在訊息框填字；Mac 的工具（選單列、切 app、網址）', async () => {
  const pages = {
    Finder: { app: 'Finder', nodes: [ctl(1, 'AXButton', '分享')] },
    LINE: { app: 'LINE', nodes: [ctl(2, 'AXRow', '', { x: 0, y: 100, w: 250, h: 70 })] },
    對話: { app: 'LINE', nodes: [ctl(3, 'AXTextArea', '', { x: 300, y: 700, w: 400, h: 60 })] },
  };
  const ax = fakeAx(pages, 'Finder', (a) => (a.action === 'press' && a.handle === 2 ? { page: '對話' } : null));
  const opened = [];
  // 切到 LINE 之後，下一步讀的是最前面的 LINE
  const screen = createMacAgentScreen({
    ax, frontApp: async () => ({ pid: ax.page() === 'Finder' ? 1 : 2 }),
    openApp: async (name) => { opened.push(name); ax.go(name); return true; },
    openUrl: async () => false,
  });
  screen.settle = async () => {};
  const ai = scriptedAi([
    { tool: 'open_app', args: { name: 'LINE' } },
    { tool: 'click', name: '沒有名字' },
    { tool: 'fill', name: '沒有名字', args: { text: '你好' } },
    { tool: 'done', args: { summary: '寫好了' } },
  ]);
  const steps = [];
  const r = await runAgent({ screen, complete: ai.complete, goal: '打開和 BU 的對話，寫好要傳的訊息（在 LINE）（要寫的訊息：你好）', onStep: (s) => steps.push(s) });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(opened, ['LINE']);
  assert.equal(steps[0].target, '「LINE」');
  assert.deepEqual(ax.acts.map((a) => [a.action, a.handle, a.text ?? '', a.pid]), [['press', 2, '', 2], ['fill', 3, '你好', 2]]);
  assert.match(ai.seen[0], /- open_app\(name/);
  // 選單列對不到：告訴 AI 那一層有什麼；打不開網址說原因；不在最前面不按
  const menuAx = { async call(op, args) {
    if (op === 'tree') return { app: 'X', window: { title: 'x' }, menus: [], nodes: [ctl(9, 'AXButton', '設定')], ms: 1 };
    if (args.action === 'menu') return { result: 'no-menu', options: ['新增視窗', '關閉視窗'], level: 1 };
    return { result: 'not-front' };
  } };
  const plain = createMacAgentScreen({ ax: menuAx, frontApp: async () => ({ pid: 5 }), openApp: async () => false, openUrl: async () => false });
  await plain.snapshot();
  assert.match((await plain.run({ tool: 'menu', args: { path: '檔案 > 新增分頁' }, why: '' })).note, /選單列裡沒有「新增分頁」（這一層有：新增視窗、關閉視窗）/);
  assert.match((await plain.run({ tool: 'open_url', args: { url: 'youtube.com' }, why: '' })).note, /打不開「youtube.com」/);
  assert.match((await plain.run({ tool: 'click', args: { ref: 'e1' }, why: '' })).note, /不在最前面/);
  assert.match((await plain.run({ tool: 'click', args: { ref: 'e7' }, why: '' })).note, /找不到 e7/);
  assert.equal(plain.describe({ tool: 'menu', args: { path: ['檔案', '新增視窗'] }, why: '' }), '「檔案 > 新增視窗」');
  assert.equal(plain.describe({ tool: 'open_url', args: { url: 'https://youtube.com' }, why: '' }), '「youtube.com」');
});

test('自動學詞：找出使用者改過的那段、只算換掉的字', () => {
  assert.equal(extractEdited('好，幫我把平行沙盒開起來。謝謝', '好，', '謝謝'), '幫我把平行沙盒開起來。');
  assert.equal(extractEdited('全部換掉了', '好，', ''), null);
  assert.deepEqual(replacedChunks('幫我把平行沙和開起來', '幫我把平行沙盒開起來'), [{ from: '和', to: '盒' }]);
  assert.deepEqual(replacedChunks('部署到 cube LV', '部署到 CubeLV'), [{ from: 'c', to: 'C' }]); // 刪掉的空白不算
  assert.deepEqual(replacedChunks('好', '好啊我晚點看'), []); // 只是多打字
});

function vocabFixture(manual, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-dictation-vocab-'));
  const file = join(dir, 'vocabulary.txt');
  writeFileSync(file, manual);
  const logs = [];
  const vocab = createVocabAuto({
    log: (m) => logs.push(m), storeFile: join(dir, 'vocabulary-auto.json'),
    settings: () => ({ vocabularyFile: file, ai: null, ...opts }),
  });
  return { file, vocab, logs, read: () => readFileSync(file, 'utf8') };
}

test('詞彙表自動更新：加在最後的自動區、你自己寫的不動、已經有的不重複、網址路徑不收', () => {
  const { vocab, read } = vocabFixture('# 產品\nCubeLV\n平行沙盒  # 中文名\n');
  assert.equal(vocab.promote('JarvisVoice', 'edit'), true);
  assert.equal(vocab.promote('jarvisvoice', 'screen'), false);
  assert.equal(vocab.promote('cubelv', 'edit'), false); // 你自己寫過
  assert.equal(vocab.promote('https://jarvis-voice.com', 'edit'), false);
  assert.equal(vocab.promote('~/jarvis-voice/bin', 'edit'), false);
  assert.equal(read(), `# 產品\nCubeLV\n平行沙盒  # 中文名\n\n${AUTO_HEADER}\nJarvisVoice\n`);
  assert.deepEqual(splitVocabulary(read()), { manualText: '# 產品\nCubeLV\n平行沙盒  # 中文名', manual: ['CubeLV', '平行沙盒'], auto: ['JarvisVoice'] });
  assert.equal(plausibleTerm('Route 53'), true);
  assert.equal(plausibleTerm('2330'), false);
});

test('詞彙表自動更新：雜湊、ID 不收；舊版收進來的載入時拿掉', () => {
  for (const id of ['5fd0ff27', 'b21cbc6', 'main 8827e2c', 'commit 6a9545fe', 'g-5de434e5', '书友160304113206784']) assert.equal(plausibleTerm(id), false, id);
  for (const word of ['a16z', 'SR008', 'arm64', 'v3.6556.2', 'renderer-dev-web-5177', 'cubelv_ai_prompt_server', 'facade']) assert.equal(plausibleTerm(word), true, word);
  const { file, vocab, logs, read } = vocabFixture(`CubeLV\n\n${AUTO_HEADER}\nJarvisVoice\n6cad1cae\n`);
  writeFileSync(join(dirname(file), 'vocabulary-auto.json'), JSON.stringify({ terms: {}, candidates: { ff9e825: { seen: 2, first: 0, last: 0 }, DeepSeek: { seen: 1, first: 0, last: 0 } } }));
  vocab.noteHits('隨便講一句');
  assert.equal(read(), `CubeLV\n\n${AUTO_HEADER}\nJarvisVoice\n`);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dirname(file), 'vocabulary-auto.json'), 'utf8')).candidates), ['DeepSeek']);
  assert.ok(logs.some((m) => m.includes('6cad1cae')));
});

test('詞彙表自動更新：畫面上的詞要 3 次不同時候（相隔 10 分鐘）都看到才加；講到了就直接加', () => {
  const { vocab, read } = vocabFixture('CubeLV\n');
  const t0 = Date.parse('2026-10-18T10:00:00Z');
  vocab.observe(['DeepSeek', 'TypeSafe'], t0);
  vocab.observe(['DeepSeek'], t0 + 60_000); // 同一次（不到 10 分鐘）不算
  vocab.observe(['DeepSeek'], t0 + 11 * 60_000);
  assert.doesNotMatch(read(), /DeepSeek/);
  vocab.observe(['DeepSeek'], t0 + 22 * 60_000);
  assert.match(read(), /DeepSeek/);
  vocab.promoteHeard('我們用 TypeSafe 的 Jev 做決策', t0 + 23 * 60_000);
  assert.match(read(), /TypeSafe/);
});

test('詞彙表自動更新：有上限，滿了先拿掉最少用到、最久沒用的自動詞；你自己寫的滿了就不加', () => {
  const now = Date.parse('2026-10-18T10:00:00Z');
  const day = 86_400_000;
  const { vocab, read, logs } = vocabFixture('A1\nB1\n', { max: 10, maxAuto: 2 });
  vocab.promote('OldScreen', 'screen', now - 20 * day);
  vocab.promote('UsedOne', 'screen', now - 20 * day);
  vocab.noteHits('今天又講到 UsedOne', now - day);
  assert.equal(vocab.promote('NewWord', 'heard', now), true);
  assert.doesNotMatch(read(), /OldScreen/); // 最少用到、最久沒用的被拿掉
  assert.match(read(), /UsedOne/);
  assert.match(read(), /NewWord/);
  assert.equal(vocab.promote('Weak', 'screen', now), false); // 新的分數不夠高就不換
  assert.ok(logs.some((l) => l.includes('不夠優先')));
  const full = vocabFixture('A\nB\nC\n', { max: 3 });
  assert.equal(full.vocab.promote('Extra', 'edit', now), false);
  assert.ok(full.logs.some((l) => l.includes('詞彙表滿了')));
});

test('詞彙表自動更新：寫完一段後從畫面挑詞（兩分鐘最多一次、畫面沒變不挑）', async () => {
  const server = await fakeJson(() => chatReply({ terms: ['JarvisVoice', 'https://x.com', 'DeepSeek'] }));
  process.env.VOICE_DICTATION_OPENAI_CHAT_URL = `${server.url}/chat`;
  try {
    const { vocab, read } = vocabFixture('CubeLV\n', { ai: { provider: 'openai', apiKey: 'sk' } });
    const t0 = Date.parse('2026-10-18T10:00:00Z');
    await vocab.afterSegment({ screen: '我們在討論 JarvisVoice 和 DeepSeek', text: '這樣用 JarvisVoice 一個月多少錢' }, t0);
    assert.equal(server.calls.length, 1);
    assert.match(read(), /JarvisVoice/); // 剛挑出來、這段又講到 → 直接加
    assert.doesNotMatch(read(), /DeepSeek/); // 只在畫面上，還是候選
    await vocab.afterSegment({ screen: '畫面換了', text: '' }, t0 + 30_000);
    assert.equal(server.calls.length, 1); // 不到兩分鐘不挑
    await vocab.afterSegment({ screen: '畫面換了', text: '' }, t0 + 3 * 60_000);
    assert.equal(server.calls.length, 2);
    await vocab.afterSegment({ screen: '畫面換了', text: '' }, t0 + 6 * 60_000);
    assert.equal(server.calls.length, 2); // 畫面沒變不挑
  } finally {
    server.close();
  }
});

test('AI 整理的提示帶上畫面上的字', () => {
  const { user, system } = buildPrompt({ transcript: '我這樣用 JavaScript 一個月多少錢', context: { screen: '…JarvisVoice 一個月約 US$9…' } });
  assert.match(user, /<screen>…JarvisVoice 一個月約 US\$9…<\/screen>/);
  assert.match(system, /<screen> 是使用者畫面上現在看得到的字/);
});

// 測試音檔：嗶一聲 1 秒、停 1 秒、再嗶 1 秒、停 2.5 秒（兩句、同一段）
function toneWav(path) {
  const rate = 24000;
  const parts = [[1, true], [1, false], [1, true], [2.5, false]];
  const pcm = Buffer.concat(parts.map(([sec, on]) => {
    const b = Buffer.alloc(Math.round(rate * sec) * 2);
    if (on) for (let i = 0; i < b.length / 2; i += 1) b.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 9000), i * 2);
    return b;
  }));
  writeFileSync(path, wavFromPcm16(pcm, rate));
}

async function runListener(dir, config, env) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const wav = join(dir, 'tone.wav');
  toneWav(wav);
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'listen.mjs'), '--file', wav, '--dry-paste'], {
    env: { ...process.env, VOICE_DICTATION_STATE_DIR: dir, ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  await new Promise((r) => child.on('close', r));
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const transcribeServer = () => fakeJson((call, n) => ({ body: { text: n === 1 ? '嗯第一句。' : '第二句。' } }));

test('整條管線：AI 整理開著時，兩句合成一段，貼 AI 整理後的字；中間停頓時提早整理的那次作廢；講完 1.2 秒就貼', { timeout: 30_000 }, async () => {
  const stt = await transcribeServer();
  const chat = await fakeJson(() => chatReply({ mode: 'insert', text: '第一句，第二句。', goal: '', app: '' }));
  try {
    const dir = mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-'));
    const events = await runListener(dir, {
      engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 }, speed: { hedge: 1 },
    }, { VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat` });
    const pasted = events.filter((e) => e.type === 'pasted');
    assert.equal(stt.calls.length, 2); // 停 0.4 秒先送的那份就是這句的結果，不重送
    assert.equal(chat.calls.length, 2); // 第一句一回來就先整理，第二句開口就作廢
    assert.match(chat.calls[0].body.messages[1].content, /<transcript>嗯第一句。<\/transcript>/);
    assert.match(chat.calls[1].body.messages[1].content, /<transcript>嗯第一句。第二句。<\/transcript>/);
    assert.deepEqual(pasted.map((e) => [e.text, e.raw]), [['第一句，第二句。', '嗯第一句。第二句。']]);
    assert.equal(readFileSync(join(dir, 'last.txt'), 'utf8'), '第一句，第二句。');
    assert.equal(pasted[0].timing.earlyTranscribe, true);
    assert.equal(pasted[0].timing.earlyPolish, true);
    assert.ok(pasted[0].latencyMs >= 1200 && pasted[0].latencyMs < 1500, `停 1.2 秒就貼，不等 segmentPauseMs：${pasted[0].latencyMs} ms`);
    // 草稿：一句一句先進框，整理好才換；草稿比換字早
    const types = events.filter((e) => ['draft', 'pasted'].includes(e.type));
    assert.deepEqual(types.map((e) => [e.type, e.text]), [['draft', '嗯第一句。'], ['draft', '第二句。'], ['pasted', '第一句，第二句。']]);
    assert.equal(pasted[0].replaced, true);
    assert.ok(pasted[0].timing.draft < pasted[0].timing.total, '草稿比換字早');
  } finally {
    stt.close();
    chat.close();
  }
});

test('整條管線：speed.draft 關掉就照原本，整理好才寫，沒有草稿', { timeout: 30_000 }, async () => {
  const stt = await transcribeServer();
  const chat = await fakeJson(() => chatReply({ mode: 'insert', text: '第一句，第二句。', goal: '', app: '' }));
  try {
    const events = await runListener(mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-')), {
      engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 }, speed: { hedge: 1, draft: false },
    }, { VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat` });
    assert.deepEqual(events.filter((e) => e.type === 'draft'), []);
    assert.deepEqual(events.filter((e) => e.type === 'pasted').map((e) => e.text), ['第一句，第二句。']);
  } finally {
    stt.close();
    chat.close();
  }
});

test('整條管線：提早轉寫、提早整理都關掉時照原本，停滿 segmentPauseMs 才整理、只問一次 AI', { timeout: 30_000 }, async () => {
  const stt = await transcribeServer();
  const chat = await fakeJson(() => chatReply({ mode: 'insert', text: '第一句，第二句。', goal: '', app: '' }));
  try {
    const events = await runListener(mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-')), {
      engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 },
      speed: { hedge: 1, earlyTranscribeMs: 0, pasteAfterMs: 0 },
    }, { VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat` });
    const pasted = events.filter((e) => e.type === 'pasted');
    assert.equal(stt.calls.length, 2);
    assert.equal(chat.calls.length, 1);
    assert.deepEqual(pasted.map((e) => e.text), ['第一句，第二句。']);
    assert.equal(pasted[0].timing.earlyTranscribe, false);
    assert.equal(pasted[0].timing.earlyPolish, false);
    assert.ok(pasted[0].latencyMs >= 1500, `停滿 1.5 秒才整理：${pasted[0].latencyMs} ms`);
  } finally {
    stt.close();
    chat.close();
  }
});

test('整條管線：AI 失敗改貼原稿；AI 整理關著時一句一句貼', { timeout: 40_000 }, async () => {
  const chat = await fakeJson(() => ({ status: 500, body: { error: { message: 'boom' } } }));
  const run = async (config) => {
    const stt = await transcribeServer();
    try {
      return await runListener(mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-')), config, {
        VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat`,
      });
    } finally {
      stt.close();
    }
  };
  try {
    const failed = await run({ engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 }, speed: { hedge: 1 } });
    assert.deepEqual(failed.filter((e) => e.type === 'pasted').map((e) => e.text), ['嗯第一句。第二句。']);
    const off = await run({ engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: false }, speed: { hedge: 1 } });
    assert.deepEqual(off.filter((e) => e.type === 'pasted').map((e) => e.text), ['嗯第一句。', '第二句。']);
    assert.equal(chat.calls.length, 2);
  } finally {
    chat.close();
  }
});

test('選單列：說話中每 0.1 秒送音量；停下後辨識中（working）一直到寫完才結束（idle）', { timeout: 30_000 }, async () => {
  const stt = await transcribeServer();
  const chat = await fakeJson(() => chatReply({ mode: 'insert', text: '第一句，第二句。', goal: '', app: '' }));
  try {
    const events = await runListener(mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-')), {
      engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 },
    }, { VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat`, VOICE_DICTATION_HUD: '1' });
    const hud = events.filter((e) => e.type === 'hud').map((e) => e.line);
    const levels = hud.filter((l) => l.startsWith('level:')).map((l) => Number(l.slice(6)));
    assert.ok(levels.length >= 10, `說話中要一直送音量：${levels.length} 次`);
    assert.ok(levels.every((v) => v >= 0 && v <= 1));
    assert.ok(Math.max(...levels) > 0.8, `嗶聲時音量偏高：${Math.max(...levels)}`);
    assert.ok(levels.some((v) => v < 0.2), '嗶聲後還沒切句的停頓，音量掉下來（聲波降回最矮）');
    const working = hud.indexOf('working');
    const idle = hud.lastIndexOf('idle');
    assert.ok(working > hud.indexOf('hearing'), '先聽到才進辨識中');
    assert.ok(idle > working, `辨識中要結束：${hud.filter((l) => !l.startsWith('level:')).join(' → ')}`);
    const pastedAt = events.findIndex((e) => e.type === 'pasted');
    assert.ok(pastedAt >= 0 && events.findIndex((e) => e.type === 'hud' && e.line === 'idle' && events.indexOf(e) > pastedAt) > pastedAt, '寫完才結束辨識中');
  } finally {
    stt.close();
    chat.close();
  }
});

test('整條管線：開了指令模式，AI 說是指令就走指令（測試模式只回報不操作）', { timeout: 30_000 }, async () => {
  const stt = await transcribeServer();
  const chat = await fakeJson(() => chatReply({ mode: 'command', text: '台積電', goal: '打開台積電（2330）的個股頁', app: '' }));
  try {
    const events = await runListener(mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-')), {
      engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 }, commands: true,
    }, { VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat` });
    assert.deepEqual(events.filter((e) => e.type === 'command').map((e) => e.goal), ['打開台積電（2330）的個股頁']);
    assert.equal(events.filter((e) => e.type === 'pasted').length, 0);
    assert.match(chat.calls[0].body.messages[0].content, /- command：/);
  } finally {
    stt.close();
    chat.close();
  }
});

test('AI 拆出傳訊息的對象和內容', () => {
  const r = parseResult('{"mode":"command","text":"BU","goal":"打開和 BU 的對話","app":"LINE","message":"你好"}', { commands: true });
  assert.deepEqual(r, { mode: 'command', text: 'BU', goal: '打開和 BU 的對話', app: 'LINE', message: '你好' });
  const { system } = buildPrompt({ transcript: '幫我傳給 BU 說你好', commands: true });
  assert.match(system, /\(c\) 叫電腦幫忙傳訊息給某個人/);
});

test('設定檢查 ai-check：照設定檔實際打 AI 和決策器；沒有 key 說缺什麼、結束碼 1', { timeout: 20_000 }, async () => {
  const server = await fakeJson((call) => {
    if (call.body?.messages?.[0]?.content?.includes('決策器')) return chatReply({ answers: { intent: { choice: 'command', confidence: 0.9 } } });
    return chatReply({ mode: 'insert', text: '我們明天四點開會，記得帶筆電。', goal: '', app: '' });
  });
  const run = async (config) => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-dictation-check-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'ai-check.mjs')], {
      env: { ...process.env, VOICE_DICTATION_STATE_DIR: dir, VOICE_DICTATION_OPENAI_CHAT_URL: `${server.url}/chat`, OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '', TYPESAFE_API_KEY: '' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r) => child.on('close', r));
    return { out, code };
  };
  try {
    const good = await run({ engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai' }, autoFocus: true, commands: true });
    assert.equal(good.code, 0, good.out);
    assert.match(good.out, /整理測試（\d+ ms）：.*→「我們明天四點開會，記得帶筆電。」/);
    assert.match(good.out, /第三層決策（AI，\d+ ms）：「進到台積電的個股頁」判成 指令/);
    assert.doesNotMatch(good.out, /sk-test/);
    const missing = await run({ ai: { enabled: true, provider: 'deepseek' } });
    assert.equal(missing.code, 1);
    assert.match(missing.out, /沒有 DeepSeek 的 key/);
  } finally {
    server.close();
  }
});

test('游標在輸入框時算不算指令：Jev 很確定，或滿確定而且講到畫面上的東西', async () => {
  const { inFieldVerdict } = await import('../bin/decide.mjs');
  const items = [el(1, 'AXButton', 'PM C'), el(2, 'AXButton', 'New session')];
  const answer = (p, choice, confidence = 0.9) => ({ intent: { probabilities: { command: p } }, target: { choice, confidence } });
  assert.equal(inFieldVerdict(answer(0.92, 'none'), items).isCommand, true); // 「打開設定」：很確定
  const named = inFieldVerdict(answer(0.8, 'e0'), items);
  assert.equal(named.isCommand, true); // 「回到 PM C」
  assert.equal(named.named.label, 'PM C');
  assert.equal(inFieldVerdict(answer(0.82, 'none'), items).isCommand, false); // 「你切到另一個分支再跑一次測試」
  assert.equal(inFieldVerdict(answer(0.63, 'e1'), items).isCommand, false);
  assert.equal(inFieldVerdict(answer(0.8, 'e0', 0.3), items).isCommand, false); // 講到哪個不確定
});
