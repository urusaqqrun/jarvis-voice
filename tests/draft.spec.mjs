// 草稿（core/draft.mjs）：字先進輸入框，整理好再換掉；已經送出、自己改過就不動。用一個假的輸入框跑規則，真的輸入框在 ax.spec.mjs。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDraftWriter } from '../core/draft.mjs';

// 假的輸入框：字都接在游標（最後面）；send() 像按了送出把框清空
function fakeField(start = '') {
  const field = {
    value: start,
    writes: [],
    replaces: [],
    down: false, // 游標不在框裡：寫不進去
    send() { field.value = ''; },
    async write(text, expect) {
      if (field.down) return { ok: false };
      const continued = !expect || field.value.endsWith(expect);
      const before = field.value;
      field.value += text;
      field.writes.push(text);
      return { ok: true, continued, before, where: { pid: 1 } };
    },
    async replace(old, text) {
      field.replaces.push([old, text]);
      if (!field.value.endsWith(old)) return 'mismatch';
      field.value = field.value.slice(0, field.value.length - old.length) + text;
      return 'ok';
    },
  };
  return field;
}

const writer = (field, options = {}) => createDraftWriter({ write: field.write, replace: field.replace, ...options });

test('草稿：字先進框，整理好換掉；同一段的句子接成一份，游標前原本的字給 AI 當上下文', async () => {
  const field = fakeField('前面的字');
  const drafts = writer(field);
  assert.deepEqual(await drafts.add('嗯第一句。'), { written: true, restart: false });
  assert.equal(field.value, '前面的字嗯第一句。');
  assert.deepEqual(await drafts.add('第二句。'), { written: true, restart: false });
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
  await drafts.add('Hello there.');
  await drafts.add('第二句。');
  assert.equal(field.value, 'Hello there. 第二句。');
});

test('草稿：整理後字一樣就不用換', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('你好。');
  assert.equal(await drafts.settle(drafts.close(), '你好。'), 'same');
  assert.deepEqual(field.replaces, []);
});

test('草稿：已經送出（框清空了）就不換，框裡不會多出字', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('你好');
  const draft = drafts.close();
  field.send();
  assert.equal(await drafts.settle(draft, '你好。'), 'mismatch');
  assert.equal(field.value, '');
  assert.equal(draft.gone, true);
});

test('草稿：自己接著打字就不換', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('你好');
  const draft = drafts.close();
  field.value += '，我自己打的';
  assert.equal(await drafts.settle(draft, '你好。'), 'mismatch');
  assert.equal(field.value, '你好，我自己打的');
});

test('草稿：同一段講到一半送出：送出的字不再算這段，整理不會把它們寫回來', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一句。');
  const first = drafts.current();
  field.send();
  assert.deepEqual(await drafts.add('第二句。'), { written: true, restart: true });
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

test('草稿：上一段還在整理又開始講下一段：下一段先進框；上一段連後面的一起換，下一段照樣換得掉', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一段');
  const first = drafts.close();
  await drafts.add('第二段');
  const second = drafts.close();
  assert.equal(field.value, '第一段第二段');
  assert.equal(await drafts.settle(first, '第一段。'), 'ok');
  assert.deepEqual(field.replaces[0], ['第一段第二段', '第一段。第二段']);
  assert.equal(field.value, '第一段。第二段');
  await drafts.add('第三段');
  assert.equal(await drafts.settle(second, '第二段。'), 'ok');
  assert.deepEqual(field.replaces[1], ['第二段第三段', '第二段。第三段']);
  assert.equal(await drafts.settle(drafts.close(), '第三段。'), 'ok');
  assert.equal(field.value, '第一段。第二段。第三段。');
});

test('草稿：上一段對不上（送出了），排在後面還沒換的也不換', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一段');
  const first = drafts.close();
  await drafts.add('第二段');
  const second = drafts.close();
  field.send();
  assert.equal(await drafts.settle(first, '第一段。'), 'mismatch');
  assert.equal(await drafts.settle(second, '第二段。'), 'gone');
  assert.equal(field.value, '');
});

test('草稿：送出後講下一段，還在整理的上一段不動，下一段從空的框開始', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一段');
  const first = drafts.close();
  field.send();
  assert.deepEqual(await drafts.add('第二段'), { written: true, restart: false });
  const second = drafts.close();
  assert.equal(second.before, '');
  assert.equal(await drafts.settle(first, '第一段。'), 'gone');
  assert.equal(await drafts.settle(second, '第二段。'), 'ok');
  assert.equal(field.value, '第二段。');
  assert.deepEqual(field.replaces, [['第二段', '第二段。']]);
});

test('草稿：游標離開框：已經寫的不再換，這句照原本整理好才寫；回到框裡沒進框的一起補上', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一句。');
  const first = drafts.current();
  field.down = true;
  assert.deepEqual(await drafts.add('第二句。'), { written: false, restart: true });
  assert.equal(first.gone, true);
  assert.equal(drafts.current(), null);
  assert.deepEqual(await drafts.add('第三句。'), { written: false, restart: false });
  field.down = false;
  assert.deepEqual(await drafts.add('第四句。'), { written: true, restart: false });
  assert.equal(field.value, '第一句。第二句。第三句。第四句。');
  assert.equal(drafts.close().text, '第二句。第三句。第四句。');
});

test('草稿：一直寫不進框就沒有草稿，照原本整理好才寫', async () => {
  const field = fakeField();
  field.down = true;
  const drafts = writer(field);
  assert.deepEqual(await drafts.add('打開設定'), { written: false, restart: false });
  assert.equal(drafts.close(), null);
});

test('草稿：寫的時候出錯當沒寫', async () => {
  const notes = [];
  const drafts = createDraftWriter({ write: async () => { throw new Error('boom'); }, replace: async () => 'ok', log: (m) => notes.push(m) });
  assert.deepEqual(await drafts.add('你好'), { written: false, restart: false });
  assert.match(notes[0], /boom/);
});

test('草稿：開頭講「指令」的這段不寫（有開語音指令才算）', async () => {
  const on = fakeField();
  const drafts = writer(on, { commands: () => true });
  assert.deepEqual(await drafts.add('指令，'), { written: false, restart: false });
  assert.deepEqual(await drafts.add('打開設定'), { written: false, restart: false });
  assert.equal(drafts.close(), null);
  assert.equal(on.value, '');
  const off = fakeField();
  assert.equal((await writer(off).add('指令這個詞')).written, true);
  assert.equal(off.value, '指令這個詞');
});

test('草稿：只有語氣詞先不寫（可能整段都不用寫），後面有話才接著寫', async () => {
  const field = fakeField();
  const drafts = writer(field);
  assert.deepEqual(await drafts.add('嗯。'), { written: false, restart: false });
  assert.equal(field.value, '');
  assert.equal(drafts.current(), null);
  await drafts.add('我覺得可以。');
  assert.equal(field.value, '我覺得可以。');
});

test('草稿：拿掉（不是要打的字）；settle 給空字串', async () => {
  const field = fakeField('原本的字');
  const drafts = writer(field);
  await drafts.add('打開設定');
  assert.equal(await drafts.settle(drafts.close(), ''), 'ok');
  assert.equal(field.value, '原本的字');
});

test('草稿：forget 之後不換，後面的草稿不受影響', async () => {
  const field = fakeField();
  const drafts = writer(field);
  await drafts.add('第一段');
  const first = drafts.close();
  await drafts.add('第二段');
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
    write: async (text) => {
      order.push(`寫 ${text}`);
      if (text === '第一段') await gate;
      value += text;
      return { ok: true, continued: true, before: '', where: {} };
    },
    replace: async (old, text) => {
      order.push(`換 ${old}→${text}`);
      assert.ok(value.endsWith(old), '換的時候前面的字都寫好了');
      value = value.slice(0, value.length - old.length) + text;
      return 'ok';
    },
  });
  const adding = drafts.add('第一段');
  assert.equal(drafts.busy(), true);
  const second = drafts.add('第二句');
  release();
  await adding;
  await second;
  assert.equal(drafts.busy(), false);
  assert.equal(await drafts.settle(drafts.close(), '整理好了'), 'ok');
  assert.deepEqual(order, ['寫 第一段', '寫 第二句', '換 第一段第二句→整理好了']);
  assert.equal(value, '整理好了');
});
