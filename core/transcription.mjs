// JarvisVoice 核心：雲端即時轉寫（OpenAI Realtime 的 transcription 協定）。Mac 小程式、CubeLV、平行沙盒共用這一份。
//   - 連到哪裡由呼叫端的 connect() 決定：OpenAI 直連（自己的 key）、平行沙盒 control 的 /v1/transcription、CubeLV 後端的 /ws/transcription。
//   - 送音：24 kHz PCM16 的 input_audio_buffer.append；斷句在本機（turns.mjs），每講完一句 commit 一次。
//   - 連線前的聲音先排著，連上再補送，按下就能講；每次連線都重新叫 connect()（語音 token 一分鐘就過期）。
//   - 連線斷了或 OpenAI 回錯（手機換網路、連線滿 10 分鐘被關掉）：重開連線，把還沒拿到逐字稿的聲音與斷句照原順序重送；
//     連續失敗 maxReconnects 次才放棄（onError 一次），不讓一次失誤把整段錄音判死。
//   - 每句逐字稿照講的順序排，帶這句講話的起訖時間（onItem）。
//   - 只聽使用者的聲音（voiceprint 選項，手機不裝模型）：開線先送 voiceprint.config（參考聲紋與門檻，還在錄樣本是 null），
//     每句 commit 前送 voiceprint.turn_info（這句講了幾秒）；後端算聲紋，不像就整句不送 OpenAI，回 voiceprint.turn。
//     舊後端不認這些事件（OpenAI 回錯，帶 voiceprint_ 開頭的 event_id）：記成不支援、不重連，照常轉寫。
//   - 「這是我的話」（claim）：後端擋掉的那句，聲音先留在這裡（最多 MAX_HELD 句）。使用者說是他講的，就另開一條連線只轉這句
//     （transcribeClip，不送聲紋設定，後端不擋），字照講的順序放回去（onItem 帶 claimed）；聲紋那邊記成你的（voiceprint.onClaim），
//     擋法變了再送一次設定。不像你的話平常照樣不轉寫，按了才轉。
// 只用 WebSocket、setTimeout、btoa、crypto.randomUUID：瀏覽器和 Node 都有，不用 node: 模組。

import { TurnSplitter } from './turns.mjs';
import { joinPolished } from './dictation.mjs';

export const MAX_RECONNECTS = 4;
const OPEN_TIMEOUT_MS = 10_000;
// Mac 小程式整天開著：安靜這麼久（而且不在收音的 app）就先關連線，下次開口再連
const IDLE_CLOSE_MS = 60_000;
// control 一條連線最多 10 分鐘：快到時趁空檔先換新的
const MAX_SOCKET_AGE_MS = 9 * 60_000;
// 聲紋擋掉的句子最多留幾句可以補回（「這是我的話」）：聲音留在記憶體，一句 10 秒約 480 KB
const MAX_HELD = 10;
// 補回一句（另開一條連線轉）最多等多久；聲音分小批送（每批 0.25 秒，跟收音一樣小，後端的訊息大小有上限）
const CLIP_TIMEOUT_MS = 20_000;
const CLIP_CHUNK_BYTES = 12_000;

export function base64FromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// 連線設定不對（沒有 key、key 錯）重試也沒用：connect() 丟這種錯就直接放棄
export function permanentError(message) {
  const error = new Error(message);
  error.permanent = true;
  return error;
}

// createTranscriber —— 一條轉寫連線（斷了會自己接回來）。
//   connect()：回傳 WebSocket 網址，或 { url, headers?, sessionUpdate? }（sessionUpdate 是開線後第一個送出的設定）。
//   append(bytes)：一段聲音；commit({ startMs, endMs })：一句講完了，回傳這句的序號。
//   onItem({ id, startMs, endMs, text, final })：每句的字有變就通知（重連時舊連線上沒定案的句子會收成空的、final）。
//   onTranscript(全部的字)、onFinal(這句的字, item)：一句定案（Mac 小程式一句一句貼）。
//   onPending()：等字的句子數變了（畫面顯示「辨識中」用）。onError(error)：放棄了（finish 中就由 finish 丟出去）。
//   discard(序號)：這句作廢（停一下先送、之後又開口，整句會重送）：它的字不算進全文，也不用等它回來。
//   startHint()：commit 前就先出字時，這句從哪裡開始；elapsed()：現在是錄音開始後幾 ms（沒有起點的字用）。
//   lazy：有東西要送才連線（Mac 小程式）；不給就馬上連（按下錄音的輸入框）。
//   voiceprint：{ config() → 擋法或 null, onReady(info) → 擋法變了?, onTurn(event) → 擋法變了?, onUnsupported() }（core/voiceprint.mjs 的
//     createRemoteVoiceprint().transcription）。後端擋掉的句子當成沒有字（不等字、不重送）。updateVoiceprint()：擋法變了再送一次。
//     onUnsupported：這個後端不會擋（舊版、沒裝模型），畫面別再顯示「正在建立聲紋」。
//   onSkipped(句子)：聲紋擋掉、還可以補回的句子有變（多一句、補回來、作廢）：[{ sequence, startMs, endMs, seconds, score, claiming }]。
//     claim(序號)：「這是我的話」，補回那句（見檔頭）。
export function createTranscriber({
  connect,
  onItem,
  onTranscript,
  onFinal,
  onPending,
  onError,
  log = () => {},
  describe = () => '',
  startHint = () => null,
  elapsed = () => 0,
  lazy = false,
  maxReconnects = MAX_RECONNECTS,
  retryBaseMs = 500,
  openTimeoutMs = OPEN_TIMEOUT_MS,
  voiceprint = null,
  onSkipped,
}) {
  const parts = new Map(); // item id → { draft, final, startMs, endMs, sequence, claimed }
  const order = [];
  const outgoing = []; // 還沒送的：{ kind: 'audio', bytes } | { kind: 'commit', turn }
  const sent = []; // 已經送給這條連線、還沒拿到逐字稿的聲音與斷句；連線斷了就照原順序重送
  const commitsWaitingForIds = [];
  const waitingForFinal = new Set();
  const pendingTurns = new Set();
  const itemTurns = new Map();
  const checkpoints = new Set();
  const dropped = new Set(); // 作廢的句子序號
  const sequenceItems = new Map(); // 句子序號 → item id（作廢時找得到已經回來的字）
  let pendingChunks = [];
  let pendingBytes = 0;
  let turnSequence = 0;
  let ws = null;
  let wsOpen = false;
  let connecting = false;
  let connectedAt = 0;
  let reconnects = 0;
  let reconnectTimer;
  let closedByClient = false;
  let fatalError = null;
  let finishRequested = false;
  let finishResolve = null;
  let finishReject = null;
  let openWaiters = [];
  let voiceprintState = 'unknown'; // unknown（還沒回）、ready（後端會擋）、unsupported（舊後端）
  const voiceprintSeen = new Set(); // 已經交給 onTurn 的句子（斷線重送同一句不記兩次樣本）
  const held = new Map(); // 聲紋擋掉、還可以補回的句子：序號 → { sequence, startMs, endMs, audio, event, claiming, learned }
  let claimsInFlight = 0;
  const claimAbort = new AbortController(); // 關掉時，正在補回的那幾條一起關
  const socketState = () => `ws=${ws?.readyState ?? 'none'}`;
  const note = (message) => {
    const extra = describe();
    log(`[transcription] ${message} ${socketState()}${extra ? ` ${extra}` : ''}`);
  };

  // 句子照講的順序接起來：中文接中文直接接，英文、數字與中文交界才空一格（跟整理後寫回輸入框同一套，joinPolished）
  // shown：畫面上顯示的（onTranscript）。作廢的句子在後面的句子有字之前先留著，重送那句的字回來才換掉，畫面上的字不會先消失再出現
  const transcript = (shown = false) => order
    .map((id, index) => {
      const part = parts.get(id);
      const text = part?.final ?? part?.draft ?? '';
      if (!part?.dropped) return text;
      return shown && !order.slice(index + 1).some((later) => { const next = parts.get(later); return (next?.final ?? next?.draft ?? '').trim(); }) ? text : '';
    })
    .filter((text) => text.trim())
    .reduce((joined, text) => joinPolished(joined, text), '');

  const ensurePart = (id) => {
    let part = parts.get(id);
    if (!part) {
      part = { draft: '', final: null, startMs: commitsWaitingForIds[0]?.startMs ?? startHint() ?? elapsed() };
      parts.set(id, part);
      order.push(id);
    }
    return part;
  };
  const publishItem = (id) => {
    const part = ensurePart(id);
    if (part.dropped) onItem?.({ id, startMs: part.startMs ?? elapsed(), endMs: part.endMs, text: '', final: true });
    else onItem?.({ id, startMs: part.startMs ?? elapsed(), endMs: part.endMs, text: part.final ?? part.draft, final: part.final !== null, ...(part.claimed ? { claimed: true } : {}) });
  };
  const publish = () => onTranscript?.(transcript(true));

  // received：這句的字拿到了（作廢的句子不算：前面的句子可能還在等，聲音要留著補送）
  const settleTurn = (sequence, received = true) => {
    pendingTurns.delete(sequence);
    // 這一句的逐字稿拿到了，它和之前送出的聲音不用再留著補送
    const confirmed = received ? sent.findIndex((op) => op.kind === 'commit' && op.turn.sequence === sequence) : -1;
    if (confirmed >= 0) sent.splice(0, confirmed + 1);
    for (const checkpoint of checkpoints) {
      if (![...pendingTurns].some((pending) => pending <= checkpoint.target)) {
        checkpoints.delete(checkpoint);
        checkpoint.resolve();
      }
    }
    onPending?.();
  };

  const maybeResolveFinish = () => {
    if (!finishRequested || !finishResolve || pendingBytes || outgoing.length || commitsWaitingForIds.length || waitingForFinal.size || claimsInFlight) return;
    const resolve = finishResolve;
    finishResolve = null;
    finishReject = null;
    resolve(transcript().trim());
  };

  const fail = (error) => {
    if (fatalError) return;
    note(error.message);
    fatalError = error;
    if (reconnectTimer !== undefined) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    for (const checkpoint of checkpoints) checkpoint.reject(error);
    checkpoints.clear();
    const waiters = openWaiters;
    openWaiters = [];
    waiters.forEach((waiter) => waiter.reject(error));
    const reject = finishReject;
    finishResolve = null;
    finishReject = null;
    if (reject) reject(error);
    else onError?.(error);
    onPending?.();
  };

  const stageAudio = () => {
    if (!pendingBytes) return;
    const merged = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const chunk of pendingChunks) { merged.set(chunk, offset); offset += chunk.length; }
    pendingChunks = [];
    pendingBytes = 0;
    outgoing.push({ kind: 'audio', bytes: merged });
  };

  const voiceprintOn = () => !!voiceprint && voiceprintState !== 'unsupported';
  const voiceprintEventId = () => `voiceprint_${crypto.randomUUID()}`;
  const sendVoiceprintConfig = (socket = ws) => {
    if (!voiceprintOn() || !socket || socket.readyState !== 1) return;
    const gate = voiceprint.config();
    socket.send(JSON.stringify({
      type: 'voiceprint.config',
      event_id: voiceprintEventId(),
      reference: gate?.reference ?? null,
      threshold: gate?.threshold ?? null,
      short_threshold: gate?.shortThreshold ?? null,
      min_seconds: gate?.minSeconds ?? null,
    }));
  };

  const reportHeld = () => onSkipped?.([...held.values()].map(({ sequence, startMs, endMs, event, claiming }) => ({
    sequence, startMs, endMs, seconds: event?.seconds ?? null, score: event?.score ?? null, claiming,
  })));
  // 擋掉的那句先留著（「這是我的話」補回用）；作廢的句子（提早送了、又開口）不留，最多留 MAX_HELD 句（丟最舊的）
  const hold = (turn, chunks, event) => {
    if (!chunks.length || dropped.has(turn.sequence)) return;
    const audio = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
    held.set(turn.sequence, { sequence: turn.sequence, startMs: turn.startMs, endMs: turn.endMs, audio, event, claiming: false, learned: false });
    for (const [sequence, other] of held) {
      if (held.size <= MAX_HELD) break;
      if (!other.claiming) held.delete(sequence);
    }
    reportHeld();
  };

  const flush = () => {
    stageAudio();
    if (!ws || !wsOpen || ws.readyState !== 1) {
      if (lazy && outgoing.length && !ws && !connecting && reconnectTimer === undefined && !fatalError && !closedByClient) open();
      return;
    }
    for (const op of outgoing.splice(0)) {
      if (op.kind === 'audio') {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64FromBytes(op.bytes) }));
      } else {
        commitsWaitingForIds.push(op.turn);
        // 這句講了幾秒（後端算聲紋時，短句用短句的門檻；後端自己只看得到含句首句尾靜音的長度）
        if (voiceprintOn() && Number.isFinite(op.turn.startMs) && Number.isFinite(op.turn.endMs)) {
          ws.send(JSON.stringify({
            type: 'voiceprint.turn_info', event_id: voiceprintEventId(), commit_event_id: op.turn.eventId,
            seconds: Math.max(0, op.turn.endMs - op.turn.startMs) / 1000,
          }));
        }
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: op.turn.eventId }));
      }
      sent.push(op);
    }
    maybeResolveFinish();
  };

  const finalize = (id, text) => {
    const part = ensurePart(id);
    part.final = text;
    part.endMs ??= elapsed();
    publishItem(id);
    publish();
    waitingForFinal.delete(id);
    const sequence = itemTurns.get(id);
    if (sequence !== undefined) { settleTurn(sequence); itemTurns.delete(id); }
  };

  const onMessage = (raw) => {
    let event;
    try { event = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    if (event.type === 'voiceprint.ready') {
      // 後端認得、但模型沒載起來：照常轉寫、不會擋，跟舊後端一樣看待
      if (event.available === false) {
        if (voiceprintState !== 'unsupported') voiceprint?.onUnsupported?.();
        voiceprintState = 'unsupported';
        return;
      }
      voiceprintState = 'ready';
      if (voiceprint?.onReady?.(event)) sendVoiceprintConfig();
      return;
    }
    if (event.type === 'voiceprint.turn') {
      const id = event.commit_event_id;
      if (id && !voiceprintSeen.has(id)) {
        voiceprintSeen.add(id);
        if (voiceprint?.onTurn?.(event)) sendVoiceprintConfig();
      }
      // 後端擋掉了：這句不會有 committed、也不會有字，從等字的清單拿掉（其他句子照順序等）
      if (event.pass === false) {
        const index = commitsWaitingForIds.findIndex((turn) => turn.eventId === id);
        if (index >= 0) {
          const [turn] = commitsWaitingForIds.splice(index, 1);
          note(`voiceprint skipped turn ${turn.sequence} score=${event.score ?? '-'}`);
          // 斷線時不用重送這句：只拿掉這句自己的聲音與 commit（前面還在等字的句子照樣留著補送）
          const at = sent.findIndex((op) => op.kind === 'commit' && op.turn.sequence === turn.sequence);
          if (at >= 0) {
            let from = at;
            while (from > 0 && sent[from - 1].kind === 'audio') from -= 1;
            hold(turn, sent.slice(from, at).map((op) => op.bytes), event);
            sent.splice(from, at - from + 1);
          }
          settleTurn(turn.sequence, false);
        }
        maybeResolveFinish();
      }
      return;
    }
    if (event.type === 'input_audio_buffer.committed') {
      const turn = commitsWaitingForIds.shift();
      if (event.item_id && turn) {
        const part = ensurePart(event.item_id);
        part.startMs = turn.startMs;
        part.endMs = turn.endMs;
        part.sequence = turn.sequence;
        sequenceItems.set(turn.sequence, event.item_id);
        if (dropped.has(turn.sequence)) part.dropped = true;
        else itemTurns.set(event.item_id, turn.sequence);
        if (part.final === null && !part.dropped) waitingForFinal.add(event.item_id);
        else settleTurn(turn.sequence, !part.dropped);
        publishItem(event.item_id);
      }
      maybeResolveFinish();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta' && event.item_id) {
      ensurePart(event.item_id).draft += event.delta ?? '';
      publishItem(event.item_id);
      publish();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed' && event.item_id) {
      reconnects = 0;
      const text = event.transcript ?? parts.get(event.item_id)?.draft ?? '';
      finalize(event.item_id, text);
      if (!parts.get(event.item_id).dropped) onFinal?.(text, { id: event.item_id, startMs: parts.get(event.item_id).startMs, endMs: parts.get(event.item_id).endMs });
      maybeResolveFinish();
      return;
    }
    const reason = `${event.error?.code ?? ''} ${event.error?.message || 'Realtime transcription failed.'}`.trim();
    if (event.type === 'conversation.item.input_audio_transcription.failed' && event.item_id) {
      // 只有這一句轉不出來：這句當成沒有字，後面照常轉
      note(`item failed ${reason}`);
      finalize(event.item_id, '');
      maybeResolveFinish();
      return;
    }
    if (event.type === 'error') {
      // 舊後端把聲紋的事件轉給了 OpenAI：不支援，之後不送，照常轉寫（不用重連）
      if (String(event.error?.event_id ?? '').startsWith('voiceprint_')) {
        if (voiceprintState === 'unknown') {
          note('voiceprint not supported by this server');
          voiceprintState = 'unsupported';
          voiceprint?.onUnsupported?.();
        }
        return;
      }
      // 斷句時這條連線裡沒有聲音：沒有東西可轉，這次斷句就算完成
      if (event.error?.code === 'input_audio_buffer_commit_empty') {
        const turn = commitsWaitingForIds.shift();
        if (turn) settleTurn(turn.sequence);
        maybeResolveFinish();
        return;
      }
      reconnect(new Error(reason));
    }
  };

  const detach = (socket) => {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try { socket.close(); } catch { /* 已經關了 */ }
  };

  function open() {
    reconnectTimer = undefined;
    connecting = true;
    Promise.resolve().then(() => connect()).then((target) => {
      connecting = false;
      if (closedByClient || fatalError) return;
      const { url, headers, sessionUpdate } = typeof target === 'string' ? { url: target } : target;
      const socket = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
      ws = socket;
      socket.onopen = () => {
        if (ws !== socket) return;
        if (sessionUpdate) socket.send(JSON.stringify(sessionUpdate));
        // 聲紋的擋法要在聲音之前到（後端從第一句就照它擋）
        sendVoiceprintConfig(socket);
        wsOpen = true;
        connectedAt = Date.now();
        flush();
        const waiters = openWaiters;
        openWaiters = [];
        waiters.forEach((waiter) => waiter.resolve());
      };
      socket.onmessage = (message) => { if (ws === socket) onMessage(message.data); };
      socket.onclose = (event) => {
        if (ws === socket && !closedByClient) reconnect(new Error(`Realtime transcription connection closed (${event.code}${event.reason ? ` ${event.reason}` : ''}).`));
      };
      socket.onerror = () => {
        if (ws === socket && !closedByClient) reconnect(new Error('Realtime transcription connection failed.'));
      };
    }, (error) => {
      connecting = false;
      if (closedByClient) return;
      if (error?.permanent) fail(error);
      else reconnect(error instanceof Error ? error : new Error(String(error)));
    });
  }

  // 換一條新連線：舊連線上還沒轉完的句子不會再有結果，連同之後的聲音照順序重送到新連線
  function reconnect(error) {
    if (closedByClient || fatalError || reconnectTimer !== undefined) return;
    if (reconnects >= maxReconnects) { fail(error); return; }
    reconnects += 1;
    note(`reconnect ${reconnects}: ${error.message}`);
    const old = ws;
    ws = null;
    wsOpen = false;
    connectedAt = 0;
    detach(old);
    // 舊連線上還沒定案的句子（講到一半就先出的字、斷了句還在等的字）都收掉，重送後由新連線的句子取代，不然會重複
    for (const [id, part] of parts) {
      if (part.final !== null) continue;
      part.draft = '';
      part.final = '';
      publishItem(id);
      itemTurns.delete(id);
    }
    waitingForFinal.clear();
    commitsWaitingForIds.length = 0;
    outgoing.unshift(...sent.splice(0));
    // 沒有要重送的東西、又是有聲音才連的：等下次開口再連
    if (lazy && !outgoing.length && !pendingBytes) { reconnects = 0; return; }
    reconnectTimer = setTimeout(open, retryBaseMs * 2 ** (reconnects - 1));
  }

  const waitForOpen = () => new Promise((resolve, reject) => {
    if (fatalError) return reject(fatalError);
    if (wsOpen) return resolve();
    if (lazy && !ws && !connecting && reconnectTimer === undefined) open();
    const timer = setTimeout(() => reject(new Error('Realtime transcription connection timed out.')), openTimeoutMs);
    openWaiters.push({
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });

  const nothingPending = () => !pendingBytes && !outgoing.length && !pendingTurns.size && !commitsWaitingForIds.length && !waitingForFinal.size;

  if (!lazy) open();

  return {
    append(bytes) {
      if (!bytes?.length || closedByClient) return;
      pendingChunks.push(bytes);
      pendingBytes += bytes.length;
    },
    commit(turn) {
      stageAudio();
      const sequence = ++turnSequence;
      pendingTurns.add(sequence);
      // event_id 這時就定好：斷線重送沿用同一個，後端回的 voiceprint.turn 對得回這句
      outgoing.push({ kind: 'commit', turn: { ...turn, sequence, eventId: `commit_${crypto.randomUUID()}` } });
      flush();
      onPending?.();
      return sequence;
    },
    flush,
    // 這句作廢：字不算進全文、不用等它；還沒送出的 commit 照送（聲音已經在連線的緩衝裡），回來的字丟掉
    discard(sequence) {
      if (!sequence || dropped.has(sequence)) return;
      dropped.add(sequence);
      if (held.has(sequence) && !held.get(sequence).claiming) { held.delete(sequence); reportHeld(); }
      const id = sequenceItems.get(sequence);
      if (id !== undefined) {
        const part = parts.get(id);
        if (part) part.dropped = true;
        itemTurns.delete(id);
        waitingForFinal.delete(id);
        publishItem(id);
        publish();
      }
      if (pendingTurns.has(sequence)) settleTurn(sequence, false);
      maybeResolveFinish();
    },
    // 「這是我的話」：擋掉的那句另開一條連線轉，字照講的順序放回去（onItem 帶 claimed）；聲紋那邊記成你的，擋法變了就送新的給後端。
    // 回傳這句的字（轉出來是空的回 ''）；連不上、逾時丟錯，那句留著可以再按。沒有這句（已經補回、作廢、太舊被丟掉）回 null
    async claim(sequence) {
      const turn = held.get(sequence);
      if (!turn || turn.claiming || closedByClient) return null;
      turn.claiming = true;
      claimsInFlight += 1;
      reportHeld();
      // 再按一次（上次沒轉成）不重記聲紋
      if (!turn.learned) {
        turn.learned = true;
        if (voiceprintOn() && voiceprint?.onClaim?.(turn.event)) sendVoiceprintConfig();
      }
      try {
        const text = (await transcribeClip({ connect, audio: turn.audio, log, signal: claimAbort.signal })).trim();
        held.delete(sequence);
        if (text) {
          const id = `claim_${sequence}`;
          parts.set(id, { draft: '', final: text, startMs: turn.startMs, endMs: turn.endMs, sequence, claimed: true });
          // 照講的順序放回去：排在比它晚講的第一句前面
          const at = order.findIndex((other) => (parts.get(other)?.sequence ?? -Infinity) > sequence);
          if (at < 0) order.push(id);
          else order.splice(at, 0, id);
          publishItem(id);
          publish();
        }
        note(`voiceprint claimed turn ${sequence} chars=${text.length}`);
        return text;
      } catch (error) {
        turn.claiming = false;
        note(`voiceprint claim failed turn ${sequence}: ${error?.message ?? error}`);
        throw error;
      } finally {
        claimsInFlight -= 1;
        reportHeld();
        maybeResolveFinish();
      }
    },
    // 送出去、還在等字的句子數
    pending: () => pendingTurns.size,
    lastSequence: () => turnSequence,
    // 擋法變了（重錄、關掉再開）：連著的話馬上送新的設定給後端
    updateVoiceprint: () => sendVoiceprintConfig(),
    busy: () => !nothingPending() || connecting,
    get failed() { return fatalError; },
    transcript: () => transcript(),
    waitForOpen,
    // 等到序號 ≤ target 的句子都拿到字
    async waitFor(target = turnSequence) {
      if (fatalError) throw fatalError;
      await waitForOpen();
      flush();
      if (fatalError) throw fatalError;
      if (![...pendingTurns].some((pending) => pending <= target)) return;
      await new Promise((resolve, reject) => { checkpoints.add({ target, resolve, reject }); });
    },
    // 不會再有新的聲音：等所有句子的字都拿到，回傳全部的字
    async finish() {
      if (fatalError) throw fatalError;
      if (finishRequested) throw new Error('Realtime transcription is already finishing.');
      finishRequested = true;
      stageAudio();
      if (!outgoing.some((op) => op.kind === 'commit') && !commitsWaitingForIds.length && !waitingForFinal.size && !claimsInFlight) return transcript().trim();
      flush();
      if (!outgoing.length && !commitsWaitingForIds.length && !waitingForFinal.size && !claimsInFlight) return transcript().trim();
      await waitForOpen();
      flush();
      return new Promise((resolve, reject) => {
        finishResolve = resolve;
        finishReject = reject;
        maybeResolveFinish();
      });
    },
    // 整天開著的用（Mac 小程式）：沒在講、沒在等字時，安靜夠久或連線快到上限就先關，下次有聲音再連
    idle({ active = true, quietForMs = 0, speaking = false } = {}) {
      if (!ws || speaking || !nothingPending()) return;
      if ((!active && quietForMs > IDLE_CLOSE_MS) || (connectedAt && Date.now() - connectedAt > MAX_SOCKET_AGE_MS)) {
        const old = ws;
        ws = null;
        wsOpen = false;
        connectedAt = 0;
        sent.length = 0;
        detach(old);
      }
    },
    close() {
      closedByClient = true;
      claimAbort.abort();
      if (reconnectTimer !== undefined) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
      for (const checkpoint of checkpoints) checkpoint.reject(new Error('Realtime transcription closed.'));
      checkpoints.clear();
      const old = ws;
      ws = null;
      wsOpen = false;
      detach(old);
      onPending?.();
    },
  };
}

// transcribeClip —— 另開一條連線只轉一段聲音（「這是我的話」補回被聲紋擋掉的那句）：不送聲紋設定（後端不擋），
// 聲音分小批送完就 commit、等字、關掉。connect 跟原本那條一樣（每次連線重新叫）。回傳這段的字；連不上、逾時、signal 中止就丟錯
export function transcribeClip({ connect, audio, log = () => {}, timeoutMs = CLIP_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let transcriber = null;
    let timer;
    const end = (error, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      transcriber?.close();
      if (error) reject(error);
      else resolve(text);
    };
    const onAbort = () => end(new Error('Clip transcription aborted.'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => end(new Error('Clip transcription timed out.')), timeoutMs);
    transcriber = createTranscriber({ connect, log, maxReconnects: 1, onError: (error) => end(error) });
    for (let offset = 0; offset < audio.length; offset += CLIP_CHUNK_BYTES) {
      transcriber.append(audio.subarray(offset, offset + CLIP_CHUNK_BYTES));
      transcriber.flush();
    }
    transcriber.commit({ startMs: 0, endMs: Math.round(audio.length / 48) });
    transcriber.finish().then((text) => end(null, text), (error) => end(error));
  });
}

// 聲音不是一開就一直在跑：AudioContext 晚開、被 iOS 中斷（另一段錄音還在收尾）、麥克風暫時沒聲音時，
// 樣本數會落後真實時間，之後每一句都被算早，第一句變成 0:00。落後超過這麼多就把時鐘拉回真實時間。
export const AUDIO_GAP_MS = 300;

// createSpeechTranscription —— 一段錄音的轉寫：收音那一頭每 100 ms 送一批樣本進來（push），這裡斷句、送音、等字。
// 平行沙盒（輸入框聽寫、驗收錄影的逐句字幕）、CubeLV（輸入框聽寫）都用這個；收音（瀏覽器的 AudioWorklet）在各 app。
//   push(samples, { startSample, at })：samples 是 Int16Array；startSample 是收音那一頭的第幾個樣本，at 是這批收完的時間（Date.now()）。
//   cut()：講到一半的那句先送出去（收音被中斷、截圖分界）。
//   checkpoint(wait)：到目前為止的聲音都切成句子送出，wait 就等字都拿到；回傳到哪一 ms 為止。
//   finish()：停止收音，等所有字拿到，回傳全部的字。
//   onActivity('idle' | 'hearing' | 'recognizing')：hearing＝正在講話；recognizing＝講完的句子送出了、還在等字。
//   earlyTranscribe（預設關）：講話中停了 earlyTranscribeMs（400）就先 commit 這句，不等 850 ms 斷句，按停止時字常常已經回來。
//     之後的聲音先留著：沒再開口就丟掉（這句就是先送的那份）；又開口時——
//     'split'：先送的那段算一句，接下來是新的一句（句子被切成兩段，不多花錢）；
//     'resend'：先送的那份作廢，這句從頭整段重送（字跟不提早一樣，重送的秒數會再計費一次）。
export function createSpeechTranscription({ recordingStartedAt, onActivity, earlyTranscribe = false, earlyTranscribeMs = 400, ...options }) {
  const origin = recordingStartedAt ?? Date.now();
  // 一批聲音的時間＝clockOffsetMs＋第幾個樣本；聲音停過一段就往後挪（AUDIO_GAP_MS）
  let clockOffsetMs = Math.max(0, Date.now() - origin);
  let capturedUntilMs = clockOffsetMs;
  let samplesSeen = 0;
  let capturing = true;
  let ended = false;
  let closed = false;
  const splitter = new TurnSplitter({ tentativeMs: earlyTranscribe ? earlyTranscribeMs : 0 });
  let turnAudio = []; // 這句到目前為止的聲音（resend 重送用）
  let pieceStartMs = null; // split：又開口後新的一段從哪裡開始
  let early = null; // 先 commit 了、還沒切句也還沒又開口：{ sequence, held（之後留著沒送的聲音） }
  let activity = 'idle';
  const elapsed = () => Math.max(0, Date.now() - origin);
  const updateActivity = () => {
    const next = closed || transcriber.failed ? 'idle'
      : capturing && splitter.speaking ? 'hearing' : transcriber.pending() ? 'recognizing' : 'idle';
    if (next === activity) return;
    activity = next;
    onActivity?.(next);
  };
  const transcriber = createTranscriber({
    ...options,
    elapsed,
    startHint: () => splitter.currentStartMs,
    onPending: () => updateActivity(),
  });
  const flushTimer = setInterval(() => transcriber.flush(), 250);
  const send = ({ audio, turn, tentative, resumed }, startMs) => {
    if (earlyTranscribe === 'resend') turnAudio.push(...audio);
    if (early) early.held.push(...audio);
    else for (const bytes of audio) transcriber.append(bytes);
    if (tentative) {
      early = { sequence: transcriber.commit({ startMs: pieceStartMs ?? splitter.currentStartMs, endMs: splitter.detector.lastVoiceEnd }), held: [] };
    } else if (resumed && early) {
      if (earlyTranscribe === 'resend') {
        transcriber.discard(early.sequence);
        let bytes = 0;
        for (const chunk of turnAudio) { transcriber.append(chunk); bytes += chunk.length; }
        options.log?.(`[transcription] early commit discarded, resent ${(bytes / 48000).toFixed(1)}s`);
      } else {
        for (const bytes of early.held) transcriber.append(bytes);
        pieceStartMs = startMs;
      }
      early = null;
    }
    if (turn) {
      // 先送的那份就是這句（後面只有靜音），不用再 commit
      if (!early) transcriber.commit(pieceStartMs === null ? turn : { ...turn, startMs: pieceStartMs });
      early = null;
      turnAudio = [];
      pieceStartMs = null;
    }
  };
  const cut = () => {
    send(splitter.finish());
    updateActivity();
  };

  return {
    push(samples, { startSample, at = Date.now() } = {}) {
      if (!capturing || !samples?.length) return;
      const durationMs = samples.length / 24;
      const sampleMs = (startSample ?? samplesSeen) / 24;
      samplesSeen = (startSample ?? samplesSeen) + samples.length;
      const actualStartMs = at - origin - durationMs;
      if (actualStartMs - (clockOffsetMs + sampleMs) > AUDIO_GAP_MS) clockOffsetMs = actualStartMs - sampleMs;
      const startMs = clockOffsetMs + sampleMs;
      capturedUntilMs = startMs + durationMs;
      send(splitter.push(samples, startMs), startMs);
      updateActivity();
    },
    cut,
    updateVoiceprint: () => transcriber.updateVoiceprint(),
    // 「這是我的話」：補回聲紋擋掉的那句（createTranscriber 的 claim）
    claim: (sequence) => transcriber.claim(sequence),
    get speaking() { return splitter.speaking; },
    get capturedUntilMs() { return capturedUntilMs; },
    get failed() { return transcriber.failed; },
    async checkpoint(wait = true) {
      if (transcriber.failed) throw transcriber.failed;
      if (ended || closed) throw new Error('Realtime transcription is ending.');
      cut();
      const boundary = capturedUntilMs;
      if (!wait) return boundary;
      await transcriber.waitFor(transcriber.lastSequence());
      return boundary;
    },
    async finish() {
      if (transcriber.failed) throw transcriber.failed;
      if (ended) throw new Error('Realtime transcription is already finishing.');
      ended = true;
      cut();
      capturing = false;
      updateActivity();
      try {
        return await transcriber.finish();
      } finally {
        clearInterval(flushTimer);
        updateActivity();
      }
    },
    // 收音停了（不再 push），句子照樣轉完
    stopCapture() {
      capturing = false;
      updateActivity();
    },
    close() {
      closed = true;
      capturing = false;
      clearInterval(flushTimer);
      transcriber.close();
      updateActivity();
    },
  };
}
