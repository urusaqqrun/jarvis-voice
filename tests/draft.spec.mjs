// 字先進輸入框（core/draft.mjs）：邊講邊打、整理好一次換掉（預覽少一截才先換成準的字）；已經送出、自己改過就不動。
// 用一個假的輸入框跑規則，真的輸入框在 ax.spec.mjs。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIVE_PAUSE_MS, createDraftWriter } from '../core/draft.mjs';

// 假的輸入框：游標在最後面；send() 像按了送出把框清空；down：游標不在框裡，寫不進去
function fakeField(start = '') {
  const field = {
    value: start,
    ops: [],
    down: false,
    idle: 60, // 使用者多久沒碰鍵盤滑鼠（秒）
    send() { field.value = ''; },
    async rewrite({ expect, same, text, why }) {
      field.ops.push({ expect, same, text, why });
      if (field.down) return { ok: false, reason: 'no-field' };
      if (!field.value.endsWith(expect)) return { ok: false, reason: 'mismatch', before: field.value, idle: field.idle };
      const before = field.value;
      field.value = field.value.slice(0, field.value.length - expect.length + same) + text;
      return { ok: true, before, where: { pid: 1 } };
    },
  };
  return field;
}

const writer = (field, options = {}) => createDraftWriter({ rewrite: field.rewrite, ...options });
// 等排隊的都做完
const idle = (drafts) => drafts.settle({ gone: true }, '');

test('草稿：字先進框，整理好換掉；同一段的句子接成一份，游標前原本的字給 AI 當上下文', async () => {
  const field = fakeField('前面的字');
  const drafts = writer(field);
  assert.deepEqual(await drafts.add('嗯第一句。', 1), { written: true, restart: false });
  assert.equal(field.value, '前面的字嗯第一句。');
  assert.deepEqual(await drafts.add('第二句。', 2), { written: true, restart: false });
  assert.equal(field.value, '前面的字嗯第一句。第二句。');
  const draft = drafts.close();
  assert.equal(draft.text, '嗯第一句。第二句。');
  assert.equal(draft.before, '前面的字');
  assert.equal(drafts.current(), null);
  assert.equal(await drafts.settle(draft, '第一句，第二句。'), 'ok');
  assert.equal(field.value, '前面的字第一句，第二句。');
});

test('草稿：英文句尾補空白，下一句才不會黏在一起', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('Hello there.', 1);
  await drafts.add('第二句。', 2);
  assert.equal(field.value, 'Hello there. 第二句。');
});

test('草稿：整理後字一樣就不用換', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('你好。', 1);
  const before = field.ops.length;
  assert.equal(await drafts.settle(drafts.close(), '你好。'), 'same');
  assert.equal(field.ops.length, before);
});

test('草稿：已經送出（框清空了）就不換，框裡不會多出字', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('你好', 1);
  const draft = drafts.close();
  field.send();
  assert.equal(await drafts.settle(draft, '你好。'), 'mismatch');
  assert.equal(field.value, '');
  assert.equal(draft.gone, true);
});

test('草稿：自己接著打字就不換', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('你好', 1);
  const draft = drafts.close();
  field.value += '，我自己打的';
  assert.equal(await drafts.settle(draft, '你好。'), 'mismatch');
  assert.equal(field.value, '你好，我自己打的');
});

test('草稿：同一段講到一半送出：送出的字不再算這段，整理不會把它們寫回來', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一句。', 1);
  const first = drafts.current();
  field.send();
  assert.deepEqual(await drafts.add('第二句。', 2), { written: true, restart: true });
  assert.equal(first.gone, true);
  assert.equal(field.value, '第二句。');
  const draft = drafts.close();
  assert.equal(draft.text, '第二句。');
  assert.equal(draft.before, '');
  assert.equal(await drafts.settle(draft, '第二句！'), 'ok');
  assert.equal(field.value, '第二句！');
  assert.equal(await drafts.settle(first, '第一句！'), 'gone');
  assert.equal(field.value, '第二句！');
});

test('草稿：上一段還在整理又開始講下一段：下一段先進框；上一段換的時候下一段不動，游標還在最後面', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一段', 1);
  const first = drafts.close();
  await drafts.add('第二段', 2);
  const second = drafts.close();
  assert.equal(field.value, '第一段第二段');
  assert.equal(await drafts.settle(first, '第一段。'), 'ok');
  assert.equal(field.value, '第一段。第二段');
  await drafts.add('第三段', 3);
  assert.equal(await drafts.settle(second, '第二段。'), 'ok');
  assert.equal(field.value, '第一段。第二段。第三段');
  const third = drafts.close();
  assert.equal(third.before, '第一段。第二段'); // 開始寫第三段時第二段還沒整理好
  assert.equal(await drafts.settle(third, '第三段。'), 'ok');
  assert.equal(field.value, '第一段。第二段。第三段。');
});

test('草稿：上一段對不上（送出了），排在後面還沒換的也不換', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一段', 1);
  const first = drafts.close();
  await drafts.add('第二段', 2);
  const second = drafts.close();
  field.send();
  assert.equal(await drafts.settle(first, '第一段。'), 'mismatch');
  assert.equal(await drafts.settle(second, '第二段。'), 'gone');
  assert.equal(field.value, '');
});

test('草稿：送出後講下一段，還在整理的上一段不動，下一段從空的框開始', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一段', 1);
  const first = drafts.close();
  field.send();
  assert.deepEqual(await drafts.add('第二段', 2), { written: true, restart: false });
  const second = drafts.close();
  assert.equal(second.before, '');
  assert.equal(await drafts.settle(first, '第一段。'), 'gone');
  assert.equal(await drafts.settle(second, '第二段。'), 'ok');
  assert.equal(field.value, '第二段。');
});

test('草稿：游標離開框：已經寫的不再換，這句照原本整理好才寫；回到框裡沒進框的一起補上', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一句。', 1);
  const first = drafts.current();
  field.down = true;
  assert.deepEqual(await drafts.add('第二句。', 2), { written: false, restart: true });
  assert.equal(first.gone, true);
  assert.equal(drafts.current(), null);
  assert.deepEqual(await drafts.add('第三句。', 3), { written: false, restart: false });
  field.down = false;
  assert.deepEqual(await drafts.add('第四句。', 4), { written: true, restart: false });
  assert.equal(field.value, '第一句。第二句。第三句。第四句。');
  assert.equal(drafts.close().text, '第二句。第三句。第四句。');
});

test('草稿：一直寫不進框就沒有草稿，照原本整理好才寫', async () => {
  const field = fakeField();
  field.down = true;
  const drafts = writer(field);
  assert.deepEqual(await drafts.add('打開設定', 1), { written: false, restart: false });
  assert.equal(drafts.close(), null);
});

test('草稿：寫的時候出錯當沒寫', async () => {
  const drafts = createDraftWriter({ rewrite: async () => { throw new Error('boom'); } });
  assert.deepEqual(await drafts.add('你好', 1), { written: false, restart: false });
});

test('草稿：開頭講「指令」的這段不寫（有開語音指令才算）', async () => {
  const on = fakeField();
  const drafts = writer(on, { commands: () => true });
  assert.deepEqual(await drafts.add('指令，', 1), { written: false, restart: false });
  assert.deepEqual(await drafts.add('打開設定', 2), { written: false, restart: false });
  assert.equal(drafts.close(), null);
  assert.equal(on.value, '');
  const off = fakeField();
  assert.equal((await writer(off).add('指令這個詞', 1)).written, true);
  assert.equal(off.value, '指令這個詞');
});

test('草稿：只有語氣詞先不寫（可能整段都不用寫），後面有話才接著寫', async () => {
  const field = fakeField();
  const drafts = writer(field);
  assert.deepEqual(await drafts.add('嗯。', 1), { written: false, restart: false });
  assert.equal(field.value, '');
  assert.equal(drafts.current(), null);
  await drafts.add('我覺得可以。', 2);
  assert.equal(field.value, '我覺得可以。');
});

test('草稿：拿掉（不是要打的字）；settle 給空字串', async () => {
  const field = fakeField('原本的字');
  const drafts = writer(field);
  await drafts.add('打開設定', 1);
  assert.equal(await drafts.settle(drafts.close(), ''), 'ok');
  assert.equal(field.value, '原本的字');
});

test('草稿：forget 之後不換，後面的草稿不受影響', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一段', 1);
  const first = drafts.close();
  await drafts.add('第二段', 2);
  const second = drafts.close();
  drafts.forget(first);
  assert.equal(await drafts.settle(first, '第一段。'), 'gone');
  assert.equal(await drafts.settle(second, '第二段。'), 'ok');
  assert.equal(field.value, '第一段第二段。');
});

test('草稿：寫和換排隊，一次做一件；寫的時候 busy', async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let value = '';
  const drafts = createDraftWriter({
    rewrite: async ({ expect, same, text, why }) => {
      order.push(`${why} ${text}`);
      if (text === '第一段') await gate;
      assert.ok(value.endsWith(expect), '前面的都寫好了才輪到這個');
      value = value.slice(0, value.length - expect.length + same) + text;
      return { ok: true, before: '', where: {} };
    },
  });
  const adding = drafts.add('第一段', 1);
  assert.equal(drafts.busy(), true);
  const second = drafts.add('第二句', 2);
  release();
  await adding;
  await second;
  assert.equal(drafts.busy(), false);
  assert.equal(await drafts.settle(drafts.close(), '整理好了'), 'ok');
  assert.deepEqual(order, ['sentence 第一段', 'sentence 第二句', 'settle 整理好了']);
  assert.equal(value, '整理好了');
});

test('邊講邊打：預覽跟著打進框，只寫多出來的字；句尾標點先不打', async () => {
  const field = fakeField('前面的字');
  const drafts = writer(field);
  drafts.preview(1, '我覺得。');
  await idle(drafts);
  assert.equal(field.value, '前面的字我覺得');
  assert.equal(drafts.typing(), true);
  drafts.preview(1, '我覺得這樣不錯。');
  await idle(drafts);
  assert.equal(field.value, '前面的字我覺得這樣不錯');
  assert.deepEqual(field.ops.at(-1), { expect: '我覺得', same: 3, text: '這樣不錯', why: 'preview' });
});

test('邊講邊打：預覽認錯改字，只換不一樣的部分', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '今天天器');
  await idle(drafts);
  drafts.preview(1, '今天天氣很好');
  await idle(drafts);
  assert.equal(field.value, '今天天氣很好');
  assert.deepEqual(field.ops.at(-1), { expect: '今天天器', same: 3, text: '氣很好', why: 'preview' });
});

test('邊講邊打：準的字回來不換掉預覽（只補句尾標點），整理好一次換掉；游標前原本的字一直是最早記下的', async () => {
  const field = fakeField('前面的字');
  const drafts = writer(field);
  drafts.preview(1, '嗯今天天器');
  await idle(drafts);
  assert.deepEqual(await drafts.add('嗯，今天天氣。', 1), { written: true, restart: false, kept: '嗯今天天器' });
  assert.equal(field.value, '前面的字嗯今天天器。');
  assert.deepEqual(field.ops.at(-1), { expect: '嗯今天天器', same: 5, text: '。', why: 'sentence' });
  const draft = drafts.close();
  assert.equal(draft.before, '前面的字');
  assert.equal(draft.text, '嗯今天天器。');
  assert.equal(draft.raw, '嗯，今天天氣。');
  assert.equal(await drafts.settle(draft, '今天天氣。'), 'ok');
  assert.equal(field.value, '前面的字今天天氣。');
  assert.equal(drafts.typing(), false);
});

test('邊講邊打：上一句的準字回來時下一句正在打：順序不亂，游標還在最後面', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '第一句');
  drafts.preview(2, '第二句講到一');
  await idle(drafts);
  assert.equal(field.value, '第一句第二句講到一');
  await drafts.add('第一句。', 1);
  assert.equal(field.value, '第一句。第二句講到一');
  drafts.preview(2, '第二句講到一半');
  await idle(drafts);
  assert.equal(field.value, '第一句。第二句講到一半');
  await drafts.add('第二句講完。', 2);
  assert.equal(field.value, '第一句。第二句講到一半。');
  const draft = drafts.close();
  assert.equal(draft.raw, '第一句。第二句講完。');
  assert.equal(await drafts.settle(draft, '第一句，第二句講完。'), 'ok');
  assert.equal(field.value, '第一句，第二句講完。');
});

test('邊講邊打：整理好的時候下一句正在打：下一句的字不動', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('嗯第一段', 1);
  const first = drafts.close();
  drafts.preview(2, '第二段');
  await idle(drafts);
  assert.equal(await drafts.settle(first, '第一段。'), 'ok');
  assert.equal(field.value, '第一段。第二段');
  await drafts.add('第二段。', 2);
  assert.equal(field.value, '第一段。第二段。');
});

test('邊講邊打：這句不算（別人在講話、轉出來是空的）：預覽拿掉，後面不再打', async () => {
  const field = fakeField('原本的字');
  const drafts = writer(field);
  drafts.preview(1, '別人講的話');
  await idle(drafts);
  assert.equal(field.value, '原本的字別人講的話');
  await drafts.drop(1);
  assert.equal(field.value, '原本的字');
  assert.equal(drafts.typing(), false);
  drafts.preview(1, '別人講的話還在講');
  await idle(drafts);
  assert.equal(field.value, '原本的字');
});

test('邊講邊打：只有雜音、語氣詞、開頭講「指令」的不打', async () => {
  const field = fakeField();
  const drafts = writer(field, { commands: () => true });
  for (const text of ['.', '嗯。', '指令，打開設定']) drafts.preview(1, text);
  await idle(drafts);
  assert.equal(field.value, '');
  assert.deepEqual(field.ops, []);
});

test('邊講邊打：講完就按送出：框裡的字就是他要的，準的字不再寫、整理也不動', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '好的我知道了');
  await idle(drafts);
  field.send();
  assert.deepEqual(await drafts.add('好的，我知道了。', 1), { written: false, restart: false, dropped: true });
  assert.equal(field.value, '');
  assert.equal(drafts.typing(), false);
  // 下一句從空的框開始
  assert.deepEqual(await drafts.add('下一句。', 2), { written: true, restart: false });
  assert.equal(field.value, '下一句。');
});

test('邊講邊打：講到一半按送出：這句後面不再打（不把送出的字打回來），下一句照常', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '講到一半');
  await idle(drafts);
  field.send();
  drafts.preview(1, '講到一半又繼續');
  await idle(drafts);
  assert.equal(field.value, '');
  assert.deepEqual(await drafts.add('講到一半又繼續。', 1), { written: false, restart: false, dropped: true });
  assert.equal(field.value, '');
  drafts.preview(2, '下一句');
  await idle(drafts);
  assert.equal(field.value, '下一句');
});

test('邊講邊打：同一段前面的句子跟這句都送出了：整段重新開始', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一句。', 1);
  drafts.preview(2, '第二句');
  await idle(drafts);
  field.send();
  assert.deepEqual(await drafts.add('第二句。', 2), { written: false, restart: true, dropped: true });
  assert.equal(drafts.current(), null);
  assert.equal(field.value, '');
});

test('邊講邊打：自己接著打字或換行：我們的字還在就不再改，準的字不寫', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '這句話');
  await idle(drafts);
  field.value += '\n';
  assert.deepEqual(await drafts.add('這句話。', 1), { written: false, restart: false, dropped: true });
  assert.equal(field.value, '這句話\n');
});

test('邊講邊打：看到字認錯自己動手改：框裡是他改的字，準的字不再寫（不會變成重複的字），也不會關掉邊講邊打', async () => {
  const notes = [];
  const field = fakeField();
  const drafts = writer(field, { log: (m) => notes.push(m) });
  drafts.preview(1, '然後這個按鈕切邊呢');
  await idle(drafts);
  field.value = '然後這個按鈕w'; // 刪掉認錯的字，自己打
  field.idle = 0.5;
  assert.deepEqual(await drafts.add('然後這個按鈕切邊了。', 1), { written: false, restart: false, dropped: true });
  assert.equal(field.value, '然後這個按鈕w');
  assert.deepEqual(notes, []);
  drafts.preview(2, '下一句還是邊講邊打');
  await idle(drafts);
  assert.equal(field.value, '然後這個按鈕w下一句還是邊講邊打');
});

test('邊講邊打：沒有人碰但後面幾個字不一樣（貼上被別的程式蓋掉）：照框裡實際的字改回來，不重複', async () => {
  const field = fakeField('前面的字');
  const drafts = writer(field, { log: () => {} });
  drafts.preview(1, '然後這個按鈕切邊呢');
  await idle(drafts);
  field.value = '前面的字然後這個按鈕w';
  assert.deepEqual(await drafts.add('然後這個按鈕切邊了。', 1), { written: true, restart: false, kept: '然後這個按鈕切邊呢' });
  assert.equal(field.value, '前面的字然後這個按鈕切邊呢。');
  assert.equal(await drafts.settle(drafts.close(), '這個按鈕切邊了。'), 'ok');
  assert.equal(field.value, '前面的字這個按鈕切邊了。');
});

test('草稿：整理好的時候自己動手改了：不換', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('然後這個按鈕切邊呢。', 1);
  const draft = drafts.close();
  field.value = '然後這個按鈕切邊了。';
  field.idle = 1;
  assert.equal(await drafts.settle(draft, '這個按鈕切邊呢。'), 'mismatch');
  assert.equal(field.value, '然後這個按鈕切邊了。');
});

test('邊講邊打：看不出來為什麼對不上（app 改了字的樣子）：準的字照樣寫不吞字，5 分鐘內不邊講邊打', async () => {
  const notes = [];
  let t = 1000;
  const field = fakeField();
  const drafts = writer(field, { now: () => t, log: (m) => notes.push(m) });
  drafts.preview(1, 'hello world');
  await idle(drafts);
  field.value = 'Hello World'; // app 自己改了大小寫
  drafts.preview(1, 'hello world again');
  await idle(drafts);
  assert.match(notes.join(), /5 分鐘內不邊講邊打/);
  assert.deepEqual(await drafts.add('hello world again.', 1), { written: true, restart: false });
  assert.equal(field.value, 'Hello Worldhello world again. ');
  drafts.preview(2, '不打');
  await idle(drafts);
  assert.equal(field.value, 'Hello Worldhello world again. ');
  t += LIVE_PAUSE_MS + 1;
  drafts.preview(3, '又會打了');
  await idle(drafts);
  assert.equal(field.value, 'Hello Worldhello world again. 又會打了');
});

test('邊講邊打：游標不在框裡：這句只試一次，字留給小框；準的字照原本整理好才寫', async () => {
  const field = fakeField();
  field.down = true;
  const drafts = writer(field);
  drafts.preview(1, '打開設定');
  await idle(drafts);
  drafts.preview(1, '打開設定頁面');
  await idle(drafts);
  assert.equal(field.ops.length, 1);
  assert.equal(drafts.typing(), false);
  assert.deepEqual(await drafts.add('打開設定頁面。', 1), { written: false, restart: false });
  assert.equal(drafts.close(), null);
});

test('邊講邊打：講到一半游標跑到按鈕：這句先不打，講完照樣寫準的字（App 會對焦回原本的框）；回不去才不寫', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '講到一半');
  await idle(drafts);
  field.down = true;
  drafts.preview(1, '講到一半離開');
  await idle(drafts);
  assert.equal(drafts.typing(), true);
  assert.equal(field.value, '講到一半');
  field.down = false; // 對焦回來了
  assert.deepEqual(await drafts.add('講到一半離開了。', 1), { written: true, restart: false });
  assert.equal(field.value, '講到一半離開了。');
  drafts.preview(2, '又講一句');
  await idle(drafts);
  field.down = true; // 回不去
  assert.deepEqual(await drafts.add('又講一句。', 2), { written: false, restart: true, dropped: true });
  assert.equal(field.value, '講到一半離開了。又講一句');
});

test('邊講邊打：游標換到別的輸入框（使用者換地方了）：框裡的字不再改，這句不再寫', async () => {
  const field = fakeField();
  const drafts = createDraftWriter({
    rewrite: async (request) => (field.moved ? { ok: false, reason: 'moved' } : field.rewrite(request)),
  });
  drafts.preview(1, '講到一半');
  await idle(drafts);
  field.moved = true;
  drafts.preview(1, '講到一半換框');
  await idle(drafts);
  assert.equal(drafts.typing(), false);
  assert.deepEqual(await drafts.add('講到一半換框了。', 1), { written: false, restart: false, dropped: true });
  assert.equal(field.value, '講到一半');
});

test('邊講邊打：排隊時只做最新的預覽；準的字回來之後舊的預覽不再打', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const field = fakeField();
  const drafts = createDraftWriter({
    rewrite: async (request) => {
      if (request.why === 'preview' && request.text === '第') await gate;
      return field.rewrite(request);
    },
  });
  drafts.preview(1, '第');
  await new Promise((r) => setTimeout(r, 0));
  drafts.preview(1, '第一');
  drafts.preview(1, '第一句');
  drafts.preview(1, '第一句話');
  release();
  await idle(drafts);
  assert.equal(field.value, '第一句話');
  assert.deepEqual(field.ops.filter((o) => o.why === 'preview').map((o) => o.text), ['第', '一句話']);
  const adding = drafts.add('第一句話。', 1);
  drafts.preview(1, '第一句話舊的預覽');
  await adding;
  await idle(drafts);
  assert.equal(field.value, '第一句話。');
});

test('邊講邊打：上一句等不到準的字（轉寫失敗）：字留在框裡算這段的字，App 併進這段才整理得到', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '轉寫失敗的句子');
  await idle(drafts);
  assert.deepEqual(await drafts.add('下一句。', 2), { written: true, restart: false, stale: '轉寫失敗的句子' });
  assert.equal(field.value, '轉寫失敗的句子下一句。');
  const draft = drafts.close();
  assert.equal(draft.text, '轉寫失敗的句子下一句。');
  assert.equal(await drafts.settle(draft, '整理好了。'), 'ok');
  assert.equal(field.value, '整理好了。');
});

test('邊講邊打：不切在 emoji 中間', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '好\u{1F600}');
  await idle(drafts);
  drafts.preview(1, '好\u{1F601}');
  await idle(drafts);
  assert.equal(field.value, '好\u{1F601}');
  assert.deepEqual(field.ops.at(-1), { expect: '好\u{1F600}', same: 1, text: '\u{1F601}', why: 'preview' });
});

test('兩段：預覽少一截（電腦卡住、預覽沒跟上）才先換成準的字，不讓字缺一塊等整理', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '先不用上');
  await idle(drafts);
  assert.deepEqual(await drafts.add('先不用上，先不用上 PRD，我們只要先待部署就好了。', 1), { written: true, restart: false });
  assert.equal(field.value, '先不用上，先不用上 PRD，我們只要先待部署就好了。');
  const draft = drafts.close();
  assert.equal(draft.text, draft.raw);
});

test('兩段：準的字句尾沒有標點：框裡的字完全不動，一次都不用寫', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '好的');
  await idle(drafts);
  const before = field.ops.length;
  assert.deepEqual(await drafts.add('好的', 1), { written: true, restart: false });
  assert.equal(field.ops.length, before);
  assert.equal(field.value, '好的');
});

test('兩段：英文預覽留著時補句尾標點和空白，下一句不會黏在一起', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, 'hello world');
  await idle(drafts);
  assert.deepEqual(await drafts.add('Hello, world.', 1), { written: true, restart: false, kept: 'hello world' });
  drafts.preview(2, 'next one');
  await idle(drafts);
  assert.equal(field.value, 'hello world. next one');
});

test('兩段：整理失敗換成準的原稿（draft.raw），預覽的錯字不會留著', async () => {
  const field = fakeField();
  const drafts = writer(field);
  drafts.preview(1, '上 PRD 吧');
  await idle(drafts);
  await drafts.add('上 prod 吧。', 1);
  const draft = drafts.close();
  assert.equal(field.value, '上 PRD 吧。');
  assert.equal(await drafts.settle(draft, draft.raw), 'ok');
  assert.equal(field.value, '上 prod 吧。');
});
