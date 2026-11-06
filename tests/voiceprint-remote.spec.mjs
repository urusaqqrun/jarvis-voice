// 手機不裝模型的聲紋過濾（CubeLV、平行沙盒）：後端算聲紋、照前端給的擋法擋；前端核心記樣本、越用越準。
// 協定在 core/transcription.mjs（voiceprint 選項），規則在 core/voiceprint.mjs（gate、passesGate、createRemoteVoiceprint）。
// 用假的 WebSocket，不連網路。

import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';

const core = await import('../core/index.mjs');

class FakeSocket {
  static all = [];
  readyState = 0;
  sent = [];
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  constructor(url, init) { this.url = url; this.init = init; FakeSocket.all.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006, reason: '' }); }
  of(type) { return this.sent.filter((e) => e.type === type); }
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => { FakeSocket.all = []; globalThis.WebSocket = FakeSocket; });
afterEach(() => { globalThis.WebSocket = realWebSocket; });

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const batch = (level) => new Int16Array(2400).fill(Math.round(level * 32767));

// 假的聲紋：使用者在 x 軸附近，別人在 y 軸附近（8 維，加一點雜訊）
function voices(seed = 11) {
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  return (axis) => core.normalize(Array.from({ length: 8 }, (_, i) => (i === axis ? 1 : 0) + rand() * 0.2));
}

const GATE = { reference: [1, 0], threshold: 0.3, shortThreshold: 0.1, minSeconds: 1.5 };

function startSpeech(voiceprint, extra = {}) {
  const errors = [];
  let sample = 0;
  const origin = Date.now();
  const session = core.createSpeechTranscription({
    connect: async () => 'wss://transcribe',
    recordingStartedAt: origin,
    retryBaseMs: 10,
    onError: (error) => errors.push(error),
    voiceprint,
    ...extra,
  });
  // 先安靜 1 秒（底噪），講 seconds 秒，再停 1 秒（停 0.85 秒就切句、commit）
  const say = (seconds) => {
    const speech = seconds * 10;
    for (let n = 0; n < speech + 20; n += 1) {
      const talking = n >= 10 && n < 10 + speech;
      session.push(batch(talking ? 0.08 : 0.002), { startSample: sample, at: origin + (sample + 2400) / 24 });
      sample += 2400;
    }
  };
  return { session, errors, say };
}

test('後端算聲紋：開線先送擋法再送聲音；每句 commit 前附這句幾秒；擋掉的句子不等字，放行的照常出字', async () => {
  const turns = [];
  const voiceprint = { config: () => GATE, onTurn: (event) => { turns.push(event); return false; } };
  const { session, errors, say } = startSpeech(voiceprint);
  await tick();
  const socket = FakeSocket.all[0];
  socket.open();
  assert.equal(socket.sent[0].type, 'voiceprint.config', '擋法要在聲音之前');
  assert.deepEqual(socket.sent[0].reference, [1, 0]);
  assert.equal(socket.sent[0].short_threshold, 0.1);
  assert.match(socket.sent[0].event_id, /^voiceprint_/);
  socket.emit({ type: 'voiceprint.ready', model: core.REMOTE_VOICEPRINT_MODEL });

  // 第一句（別人）：後端擋掉
  say(2);
  await tick(300);
  const [info] = socket.of('voiceprint.turn_info');
  const [commit] = socket.of('input_audio_buffer.commit');
  assert.equal(info.commit_event_id, commit.event_id);
  assert.ok(Math.abs(info.seconds - 2) < 0.15, `這句講了約 2 秒（${info.seconds}）`);
  socket.emit({ type: 'voiceprint.turn', commit_event_id: commit.event_id, pass: false, score: 0.05, seconds: 2, embedding: [0, 1] });

  // 第二句（自己）：放行，照常 committed、出字
  say(2);
  await tick(300);
  const second = socket.of('input_audio_buffer.commit')[1];
  socket.emit({ type: 'voiceprint.turn', commit_event_id: second.event_id, pass: true, score: 0.8, seconds: 2, embedding: [1, 0] });
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'mine' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'mine', transcript: '這是我講的' });

  assert.equal(await session.finish(), '這是我講的');
  assert.deepEqual(turns.map((t) => t.pass), [false, true]);
  assert.equal(FakeSocket.all.length, 1);
  assert.deepEqual(errors, []);
  session.close();
});

test('後端算聲紋：斷線重連時，擋掉的句子不重送、還在等字的照常補送；同一句的聲紋只記一次；擋法重送一次', async () => {
  let onTurnCalls = 0;
  const voiceprint = { config: () => GATE, onTurn: () => { onTurnCalls += 1; return false; } };
  const { session, errors, say } = startSpeech(voiceprint);
  await tick();
  const first = FakeSocket.all[0];
  first.open();
  first.emit({ type: 'voiceprint.ready', model: core.REMOTE_VOICEPRINT_MODEL });
  say(2); // A：自己，放行但字還沒回來
  await tick(300);
  say(2); // B：別人，擋掉
  await tick(300);
  const [a, b] = first.of('input_audio_buffer.commit');
  first.emit({ type: 'voiceprint.turn', commit_event_id: a.event_id, pass: true, score: 0.7, seconds: 2, embedding: [1, 0] });
  first.emit({ type: 'voiceprint.turn', commit_event_id: b.event_id, pass: false, score: 0.0, seconds: 2, embedding: [0, 1] });
  first.drop();
  await tick(40);
  const second = FakeSocket.all[1];
  second.open();
  assert.equal(second.sent[0].type, 'voiceprint.config');
  const resent = second.of('input_audio_buffer.commit');
  assert.deepEqual(resent.map((c) => c.event_id), [a.event_id], '只補送 A，同一個 event_id');
  second.emit({ type: 'voiceprint.turn', commit_event_id: a.event_id, pass: true, score: 0.7, seconds: 2, embedding: [1, 0] });
  second.emit({ type: 'input_audio_buffer.committed', item_id: 'a' });
  second.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: '第一句' });
  assert.equal(await session.finish(), '第一句');
  assert.equal(onTurnCalls, 2, 'A 重送後再回一次，不再記');
  assert.deepEqual(errors, []);
  session.close();
});

test('後端算聲紋：舊後端把設定轉給 OpenAI、回錯（event_id 是 voiceprint_ 開頭）：不重連、之後不送，照常轉寫', async () => {
  let unsupported = 0;
  const voiceprint = { config: () => GATE, onTurn: () => false, onUnsupported: () => { unsupported += 1; } };
  const { session, errors, say } = startSpeech(voiceprint);
  await tick();
  const socket = FakeSocket.all[0];
  socket.open();
  // 實際 OpenAI 回的（10/19 箱子接 dev 舊版 ai_prompt 量到的）
  const oldServerError = { type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', message: "Invalid value: 'voiceprint.config'. Supported values are: 'session.update', ...", param: 'type', event_id: socket.sent[0].event_id } };
  socket.emit(oldServerError);
  socket.emit(oldServerError);
  assert.equal(unsupported, 1, '畫面只收一次通知');
  say(2);
  await tick(300);
  assert.equal(socket.of('voiceprint.turn_info').length, 0, '知道不支援後就不送');
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'x' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'x', transcript: '照常轉寫' });
  assert.equal(await session.finish(), '照常轉寫');
  assert.equal(FakeSocket.all.length, 1, '沒有重連');
  assert.deepEqual(errors, []);
  session.close();
});

test('後端認得但模型沒載起來（available=false）：當成不支援，之後不送聲紋事件', async () => {
  let unsupported = 0;
  const voiceprint = { config: () => GATE, onTurn: () => false, onUnsupported: () => { unsupported += 1; } };
  const { session, say } = startSpeech(voiceprint);
  await tick();
  const socket = FakeSocket.all[0];
  socket.open();
  socket.emit({ type: 'voiceprint.ready', model: core.REMOTE_VOICEPRINT_MODEL, available: false });
  say(2);
  await tick(300);
  assert.equal(unsupported, 1);
  assert.equal(socket.of('voiceprint.turn_info').length, 0);
  session.close();
});

test('擋法：還在錄樣本是 null；錄好後 passesGate 跟 judge 放不放行一樣（短句用短句的門檻）', () => {
  const voice = voices();
  const vp = core.createVoiceprint();
  assert.equal(vp.gate(), null);
  assert.equal(core.passesGate(null, 0, 3), true, '還在錄樣本：放行');
  for (let i = 0; i < 4; i += 1) vp.judge(voice(0), 3);
  const gate = vp.gate();
  assert.ok(gate.reference.length === 8);
  for (const [axis, sec] of [[0, 3], [1, 3], [0, 1], [1, 1], [2, 0.8]]) {
    const v = voice(axis);
    const score = core.cosine(v, gate.reference);
    assert.equal(core.passesGate(gate, score, sec), vp.judge(v, sec, { dryRun: true }).pass, `axis ${axis} ${sec}s`);
  }
  assert.equal(core.passesGate(gate, null, 3), true, '算不出聲紋：放行');
});

test('前端記樣本：後端送回來的聲紋湊滿樣本就存檔、擋法變了要再送；換了模型就重錄；重錄會刪存檔', () => {
  const voice = voices(5);
  let saved = null;
  const changes = [];
  const store = { load: () => saved, save: (s) => { saved = s; }, clear: () => { saved = null; } };
  const remote = core.createRemoteVoiceprint({ store, onChange: (c) => changes.push(c) });
  const t = remote.transcription;
  assert.equal(t.config(), null);
  const turn = (axis, seconds = 3, pass = true) => t.onTurn({ type: 'voiceprint.turn', commit_event_id: 'c', pass, score: null, seconds, embedding: voice(axis) });
  assert.equal(turn(0), false);
  assert.ok(saved.pending.length === 1, '錄樣本中也存（下次接著錄）');
  turn(1);
  turn(0);
  assert.equal(turn(0), true, '湊滿 10 秒：擋法有了');
  assert.equal(saved.model, core.REMOTE_VOICEPRINT_MODEL);
  assert.equal(saved.enrolled.length, 3, '別人那句不算進樣本');
  assert.ok(t.config().reference.length === 8);
  assert.equal(changes.at(-1).enrolled, true);
  assert.ok(changes.every((c) => !('needSeconds' in c)) && !('needSeconds' in remote), '聲紋在背景學：不給還要講幾秒');
  // 後端擋掉的句子：不記進樣本、擋法不變
  assert.equal(turn(1, 3, false), false);
  assert.equal(changes.at(-1).pass, false);
  // 存檔讀回來：一樣是錄好的
  const again = core.createRemoteVoiceprint({ store });
  assert.equal(again.enrolled(), true);
  assert.equal(again.transcription.onReady({ model: core.REMOTE_VOICEPRINT_MODEL }), false);
  assert.equal(again.transcription.onReady({ model: 'another-model' }), true, '換了模型：重錄，擋法要再送');
  assert.equal(again.enrolled(), false);
  assert.equal(saved, null);
  remote.reset();
  assert.equal(remote.enrolled(), false);
});

// 門檻（計劃 cubelv_docs 2026-10-19_聲紋門檻依個人自動調.md）：長句 0.3、短句 0.4 打底，同一場跟著你的分數往上提
// 跟參考聲紋相似度剛好是 s 的聲紋
function scorer(vp, voice) {
  const ref = vp.gate().reference;
  const v1 = voice(1);
  const orth = core.normalize(v1.map((x, i) => x - core.cosine(v1, ref) * ref[i]));
  return (s) => core.normalize(ref.map((x, i) => s * x + Math.sqrt(1 - s * s) * orth[i]));
}

test('門檻：打底 0.3／0.4；同一場很確定是你的長句（0.5 以上）滿 3 句後＝最近 5 句中位數 − 0.45（最高 0.5），短句跟著；10 分鐘沒講回到打底', () => {
  assert.equal(core.VOICEPRINT_THRESHOLD, 0.3);
  assert.equal(core.VOICEPRINT_SHORT_THRESHOLD, 0.4);
  let t = 0;
  const voice = voices(13);
  const vp = core.createVoiceprint({ now: () => t });
  for (let i = 0; i < 4; i += 1) vp.judge(voice(0), 3);
  assert.equal(vp.enrolled(), true);
  assert.equal(vp.threshold(), 0.3);
  const at = scorer(vp, voice);
  assert.equal(vp.judge(at(0.42), 3, { dryRun: true }).pass, true, '聲音像你的旁人 0.42：一開始會過');
  // 你講了兩句還不算（1.8 秒：長句，但不到 2 秒不加進最近的聲音，參考聲紋不變）
  for (let i = 0; i < 2; i += 1) { t += 20000; assert.equal(vp.judge(at(0.9), 1.8).pass, true); }
  assert.equal(vp.threshold(), 0.3);
  t += 20000;
  vp.judge(at(0.9), 1.8);
  assert.ok(Math.abs(vp.threshold() - 0.45) < 1e-9, `第三句後 ${vp.threshold()}`);
  assert.deepEqual({ th: vp.gate().threshold, short: vp.gate().shortThreshold }, { th: vp.threshold(), short: vp.threshold() });
  assert.equal(vp.judge(at(0.42), 3, { dryRun: true }).pass, false, '旁人 0.42 長句：擋');
  assert.equal(vp.judge(at(0.42), 1, { dryRun: true }).pass, false, '旁人 0.42 短句：擋');
  assert.equal(vp.judge(at(0.5), 1, { dryRun: true }).pass, true);
  // 不像的句子、漏網的旁人（放行但不到 0.5）都不記進這一場，門檻不會被往下拉
  vp.judge(at(0.1), 3);
  vp.judge(at(0.47), 1.8);
  assert.equal(vp.state().session.length, 3);
  assert.ok(Math.abs(vp.threshold() - 0.45) < 1e-9);
  // 存檔讀回一樣
  const again = core.createVoiceprint({ state: JSON.parse(JSON.stringify(vp.state())), now: () => t });
  assert.equal(again.threshold(), vp.threshold());
  // 最高 0.5
  for (let i = 0; i < 3; i += 1) { t += 20000; vp.judge(at(0.99), 1.8); }
  assert.equal(vp.threshold(), 0.5);
  // 10 分鐘沒講：回到打底（換了地方分數整段掉下來也不會被卡住）
  t += 11 * 60 * 1000;
  assert.equal(vp.threshold(), 0.3);
  assert.equal(vp.judge(at(0.32), 3).pass, true);
  vp.reset();
  assert.deepEqual(vp.state().session, []);
});

test('前端記樣本：這一場的門檻動了也算擋法變了（核心再送一次設定），這一場的分數跟著存檔', () => {
  let t = 0;
  const voice = voices(17);
  let saved = null;
  const store = { load: () => saved, save: (s) => { saved = s; }, clear: () => { saved = null; } };
  const remote = core.createRemoteVoiceprint({ store, now: () => t });
  const turn = (sec) => { t += 20000; return remote.transcription.onTurn({ type: 'voiceprint.turn', commit_event_id: 'c', pass: true, score: null, seconds: sec, embedding: voice(0) }); };
  for (let i = 0; i < 4; i += 1) turn(3);
  assert.equal(remote.transcription.config().threshold, 0.3);
  assert.equal(turn(1), false, '短句不算進這一場：擋法不變');
  assert.equal(turn(1.8), false);
  assert.equal(turn(1.8), false);
  assert.equal(saved.session.length, 2, '這一場的分數存檔');
  assert.equal(turn(1.8), true, '第三句：門檻往上提，擋法要再送');
  assert.ok(remote.transcription.config().threshold > 0.45, `${remote.transcription.config().threshold}`);
  assert.equal(saved.session.length, 3);
});

// 「這是我的話」：擋掉的那句聲音留在前端，按了另開一條連線只轉這句、照講的順序插回去；聲紋那邊記成你的
const audioBytes = (messages) => messages.reduce((n, m) => n + Buffer.from(m.audio, 'base64').length, 0);
// 第 index 句（從 0 算）commit 之前送的聲音（上一句 commit 之後）
const turnAppends = (socket, index) => {
  const commits = socket.sent.map((e, i) => (e.type === 'input_audio_buffer.commit' ? i : -1)).filter((i) => i >= 0);
  const from = index === 0 ? 0 : commits[index - 1] + 1;
  return socket.sent.slice(from, commits[index]).filter((e) => e.type === 'input_audio_buffer.append');
};

test('這是我的話：擋掉的那句聲音留著；claim 另開一條連線（不送聲紋設定）只轉這句，字插回原本的位置；聲紋記成你的、擋法再送一次', async () => {
  const claimed = [];
  const skippedLists = [];
  const items = [];
  const voiceprint = { config: () => GATE, onTurn: () => false, onClaim: (event) => { claimed.push(event); return true; } };
  const { session, errors, say } = startSpeech(voiceprint, { onSkipped: (list) => skippedLists.push(list), onItem: (item) => items.push(item) });
  await tick();
  const main = FakeSocket.all[0];
  main.open();
  main.emit({ type: 'voiceprint.ready', model: core.REMOTE_VOICEPRINT_MODEL });
  const answer = (index, pass, text) => {
    const commit = main.of('input_audio_buffer.commit')[index];
    main.emit({ type: 'voiceprint.turn', commit_event_id: commit.event_id, pass, score: pass ? 0.8 : 0.16, seconds: 2, embedding: pass ? [1, 0] : [0.2, 1] });
    if (!pass) return;
    main.emit({ type: 'input_audio_buffer.committed', item_id: `item${index}` });
    main.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: `item${index}`, transcript: text });
  };
  say(2); await tick(300); answer(0, true, '第一句');
  say(2); await tick(300); answer(1, false);
  say(2); await tick(300); answer(2, true, '第三句');
  assert.deepEqual(skippedLists.at(-1).map((t) => ({ sequence: t.sequence, score: t.score, claiming: t.claiming })), [{ sequence: 2, score: 0.16, claiming: false }]);

  const pending = session.claim(2);
  assert.equal(skippedLists.at(-1)[0].claiming, true, '按下去就標補回中');
  assert.equal(claimed.length, 1, '聲紋那邊馬上記成你的');
  assert.equal(main.of('voiceprint.config').length, 2, '擋法變了：主連線再送一次設定');
  await tick();
  assert.equal(FakeSocket.all.length, 2, '另開一條連線');
  const clip = FakeSocket.all[1];
  clip.open();
  assert.equal(clip.of('voiceprint.config').length, 0, '補回那條不送聲紋設定（後端不擋）');
  assert.equal(clip.of('voiceprint.turn_info').length, 0);
  assert.equal(audioBytes(clip.of('input_audio_buffer.append')), audioBytes(turnAppends(main, 1)), '送的是被擋那句的聲音');
  assert.ok(clip.of('input_audio_buffer.append').every((m) => Buffer.from(m.audio, 'base64').length <= 12000), '分小批送');
  assert.equal(clip.of('input_audio_buffer.commit').length, 1);
  clip.emit({ type: 'input_audio_buffer.committed', item_id: 'clip' });
  clip.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'clip', transcript: '第二句' });
  assert.equal(await pending, '第二句');
  assert.equal(clip.readyState, 3, '轉完就關掉');
  assert.deepEqual(skippedLists.at(-1), [], '補回了：不再列在略過的句子裡');
  const back = items.find((item) => item.claimed);
  assert.deepEqual({ text: back.text, final: back.final }, { text: '第二句', final: true });
  assert.equal(await session.claim(2), null, '同一句不能補兩次');
  assert.equal(await session.finish(), '第一句第二句第三句', '照講的順序插回去');
  assert.deepEqual(errors, []);
  session.close();
});

test('這是我的話：還沒轉好就按停止，finish 等它補回來；連不上就丟錯、那句留著可以再按，聲紋只記一次', async () => {
  const claimed = [];
  const skippedLists = [];
  const voiceprint = { config: () => GATE, onTurn: () => false, onClaim: (event) => { claimed.push(event); return false; } };
  const { session, errors, say } = startSpeech(voiceprint, { onSkipped: (list) => skippedLists.push(list) });
  await tick();
  const main = FakeSocket.all[0];
  main.open();
  say(2);
  await tick(300);
  const [commit] = main.of('input_audio_buffer.commit');
  main.emit({ type: 'voiceprint.turn', commit_event_id: commit.event_id, pass: false, score: 0.2, seconds: 2, embedding: [0, 1] });

  // 第一次：補回那條連兩次都斷（重連一次就放棄）
  const failed = session.claim(1);
  await tick();
  FakeSocket.all[1].drop();
  await tick(600);
  FakeSocket.all[2].drop();
  await assert.rejects(failed);
  assert.equal(skippedLists.at(-1)[0].claiming, false, '轉不出來：那句留著');
  assert.equal(main.of('voiceprint.config').length, 1, 'onClaim 回 false：擋法沒變就不再送');

  // 再按一次，這次還沒轉好就按停止
  const again = session.claim(1);
  await tick();
  const finished = session.finish();
  let done = false;
  void finished.then(() => { done = true; });
  await tick(50);
  assert.equal(done, false, 'finish 等補回那句');
  const clip = FakeSocket.all[3];
  clip.open();
  clip.emit({ type: 'input_audio_buffer.committed', item_id: 'clip' });
  clip.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'clip', transcript: '是我講的' });
  assert.equal(await again, '是我講的');
  assert.equal(await finished, '是我講的');
  assert.equal(claimed.length, 1, '再按一次不重記聲紋');
  assert.deepEqual(errors, []);
  session.close();
});

test('這是我的話：一次補好幾句、晚講的先轉好，字照講的順序交出去（onItem），補不回來的那句不擋後面', async () => {
  const items = [];
  const transcriber = core.createTranscriber({
    connect: async () => 'wss://transcribe',
    voiceprint: { config: () => GATE, onTurn: () => false },
    onItem: (item) => { if (item.final && item.text) items.push(item.text); },
  });
  await tick();
  const main = FakeSocket.all[0];
  main.open();
  const sequences = [1, 2, 3].map((n, index) => {
    transcriber.append(new Uint8Array(4800).fill(n));
    const sequence = transcriber.commit({ startMs: index * 1000, endMs: index * 1000 + 500 });
    main.emit({ type: 'voiceprint.turn', commit_event_id: main.of('input_audio_buffer.commit')[index].event_id, pass: false, score: 0.1, seconds: 1, embedding: [0, 1] });
    return sequence;
  });
  const claims = sequences.map((sequence) => transcriber.claim(sequence));
  await tick();
  const [clip1, clip2, clip3] = FakeSocket.all.slice(1);
  for (const clip of [clip1, clip2, clip3]) clip.open();
  const answer = (clip, text) => {
    clip.emit({ type: 'input_audio_buffer.committed', item_id: 'c' });
    clip.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'c', transcript: text });
  };
  answer(clip3, '第三句');
  await tick();
  assert.deepEqual(items, [], '前面的還沒回來：先等');
  // 第一句那條斷兩次（重連一次就放棄）：補不回來
  clip1.drop();
  await tick(600);
  FakeSocket.all.at(-1).drop();
  await assert.rejects(claims[0]);
  assert.deepEqual(items, [], '第二句還沒回來：第三句繼續等');
  answer(clip2, '第二句');
  await claims[1];
  await claims[2];
  assert.deepEqual(items, ['第二句', '第三句'], '照講的順序；補不回來的那句不擋');
  assert.equal(transcriber.transcript(), '第二句第三句');
  transcriber.close();
});

test('這是我的話：作廢的句子（提早送、又開口）不留；關掉之後補回中的那條一起關', async () => {
  const skippedLists = [];
  const transcriber = core.createTranscriber({
    connect: async () => 'wss://transcribe',
    voiceprint: { config: () => GATE, onTurn: () => false },
    onSkipped: (list) => skippedLists.push(list),
  });
  await tick();
  const main = FakeSocket.all[0];
  main.open();
  const say = () => { transcriber.append(new Uint8Array(4800).fill(1)); return transcriber.commit({ startMs: 0, endMs: 100 }); };
  const skip = (index) => main.emit({ type: 'voiceprint.turn', commit_event_id: main.of('input_audio_buffer.commit')[index].event_id, pass: false, score: 0.1, seconds: 1, embedding: [0, 1] });
  const first = say();
  skip(0);
  assert.equal(skippedLists.at(-1).length, 1);
  transcriber.discard(first);
  assert.deepEqual(skippedLists.at(-1), [], '作廢：不能補回');
  assert.equal(await transcriber.claim(first), null);
  const second = say();
  skip(1);
  const pending = transcriber.claim(second);
  await tick();
  const clip = FakeSocket.all[1];
  transcriber.close();
  await assert.rejects(pending, /aborted/);
  assert.equal(clip.readyState, 3, '補回那條也關了');
});

test('這是我的話（confirm）：分數連打底都不到＝聲紋學錯了，從按的這幾句重學；有到打底只是被這一場的門檻擋掉，就加進最近的聲音、這一場門檻降回那句以下（不低於打底）', () => {
  let t = 0;
  const voice = voices(23);
  const vp = core.createVoiceprint({ now: () => t });
  for (let i = 0; i < 4; i += 1) vp.judge(voice(0), 3);
  assert.equal(vp.enrolled(), true);
  // 學錯的聲紋：自己的聲音（axis 2）0.2 被擋。按「這是我的話」三句就重學好
  const mine = voice(2);
  assert.equal(vp.judge(mine, 4, { dryRun: true }).pass, false);
  assert.deepEqual(vp.confirm(mine, 4, 0.2), { relearn: true });
  assert.equal(vp.gate(), null, '重學中：每句都放行');
  assert.equal(vp.state().pending.length, 1, '按的這句是第一個樣本');
  assert.deepEqual(vp.confirm(voice(2), 4, 0.26), { relearn: false }, '重學中再按：當樣本');
  vp.confirm(voice(2), 4, 0.18);
  assert.equal(vp.enrolled(), true, '三句湊滿 10 秒：學好了');
  assert.equal(vp.judge(voice(2), 3, { dryRun: true }).pass, true, '自己的聲音過了');

  // 被這一場往上提的門檻擋掉（0.42 < 0.5）：加進最近的聲音，這一場門檻降到 0.37
  const at = scorer(vp, voice);
  for (let i = 0; i < 3; i += 1) { t += 20000; vp.judge(at(0.99), 1.8); }
  assert.equal(vp.threshold(), 0.5);
  const recentBefore = vp.state().recent.length;
  assert.deepEqual(vp.confirm(at(0.42), 3, 0.42), { relearn: false });
  assert.equal(vp.state().recent.length, recentBefore + 1, '加進最近的聲音');
  assert.ok(Math.abs(vp.threshold() - 0.37) < 1e-9, `${vp.threshold()}`);
  assert.ok(Math.abs(vp.gate().shortThreshold - 0.37) < 1e-9, '短句也跟著降');
  // 短句 0.33 被擋（短句門檻）再按：降到打底 0.3 就停
  vp.confirm(at(0.33), 1, 0.33);
  assert.equal(vp.threshold(), 0.3);
  assert.equal(vp.gate().shortThreshold, 0.3);
  // 存檔讀回一樣；10 分鐘後回到原本的算法
  const again = core.createVoiceprint({ state: JSON.parse(JSON.stringify(vp.state())), now: () => t });
  assert.equal(again.gate().shortThreshold, 0.3);
  t += 11 * 60 * 1000;
  assert.equal(vp.threshold(), 0.3);
  assert.equal(vp.gate().shortThreshold, 0.4);
  vp.reset();
  assert.deepEqual(vp.state().claims, []);
});

test('這是我的話（前端記樣本）：onClaim 記成你的、存檔；擋法變了回 true', () => {
  const voice = voices(29);
  let saved = null;
  const store = { load: () => saved, save: (s) => { saved = s; }, clear: () => { saved = null; } };
  const remote = core.createRemoteVoiceprint({ store });
  for (let i = 0; i < 4; i += 1) remote.transcription.onTurn({ type: 'voiceprint.turn', commit_event_id: `c${i}`, pass: true, score: null, seconds: 3, embedding: voice(0) });
  assert.equal(remote.enrolled(), true);
  assert.equal(remote.transcription.onClaim({ type: 'voiceprint.turn', commit_event_id: 'x', pass: false, score: 0.1, seconds: 4, embedding: voice(3) }), true, '重學：擋法變了');
  assert.equal(remote.transcription.config(), null);
  assert.equal(saved.enrolled.length, 0, '存檔也是重學中');
  assert.equal(saved.pending.length, 1);
  assert.equal(remote.transcription.onClaim({ type: 'voiceprint.turn', commit_event_id: 'y', pass: false, score: 0.1, seconds: 4, embedding: null }), false, '沒有聲紋：不記');
});
