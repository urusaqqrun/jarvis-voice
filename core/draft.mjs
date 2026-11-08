// JarvisVoice 核心：字先進輸入框。講話中就把本機預覽認到的字打進游標所在的輸入框（邊講邊打），一段講完換成 AI 整理後的字。
// 框裡的字只換一次：準的轉寫回來不換掉預覽（只補句尾標點），準的字給 AI 整理用；預覽少一截（電腦卡住、預覽沒跟上）才換成準的字。
// 沒有預覽的句子（講太短、聲紋還不夠像你）準的字回來就先寫。想送就直接送，不用等。
//   preview(第幾句, 字)：這句講到一半認到的字（每次都是這句從頭到現在），框裡跟著改。
//   add(一句, 第幾句)：這句準的字回來了，接進這段的草稿（預覽留著或換成準的字，見上面）；同一段的句子接成一份草稿。
//     草稿的 text 是框裡實際的字，raw 是準的字（AI 整理失敗時換成 raw）。
//   drop(第幾句)：這句不算（別人在講話、轉出來沒有字）：把預覽拿掉。
//   close()：這段講完了，交出這段的草稿（沒寫進去就是 null，照原本整理好才寫）。
//   settle(草稿, 字)：整理好了，把草稿換成這些字（空字串＝拿掉）。
// 只改自己寫的字：每次都先確認游標前面正好是我們寫的字。對不上——
//   使用者自己動了（送出、清空、接著打字、手動改字、換行，或游標換到別的框）：這些字都不再改，框裡講到一半的那句也不再寫；
//     手動改字認得出來，靠使用者剛碰過鍵盤滑鼠（11/04 看到字認錯馬上自己改，整句又被寫一次變成重複的字）；
//   沒有人碰，只有後面幾個字不一樣（貼上被別的程式蓋掉）：照框裡實際的字改回來；
//   看不出來（app 把字改了樣子、讀不準）：不再改，但那句準的字照樣寫進去（不吞字），之後 5 分鐘不邊講邊打。
// 接頭：
//   rewrite({ expect, same, text, where, why }) → { ok, before, where } 或 { ok: false, reason, before }：
//     游標前面要正好是 expect（我們寫的字），留下 expect 的前 same 個字，後面換成 text。where 是第一次寫的時候 App 回的
//     （哪個 app、哪個框；null＝寫在最前面的 app），why 是 preview、sentence、settle、drop（給 App 記 log、決定要不要搶焦點）。
//     before：寫之前游標前的字（第一次寫時記下來，給 AI 當上下文，不然 AI 會以為草稿本來就在框裡）；對不上時是現在游標前的字。
//     reason：mismatch（對不上，另外回 idle：使用者多久沒碰鍵盤滑鼠，秒）、moved（游標在別的輸入框），
//     或寫不進去的原因（游標不在框裡、選取了字、讀不到框…，這句照原本整理好才寫）。
//   commands()：有沒有開語音指令（開頭講「指令」的這段一定是要操作，不寫）。
// 寫和改都排隊一次做一件：都要先確認游標前面的字，不能交錯。

import { isExplicitCommand } from './flow.mjs';
import { isSpeech, onlyFiller, withSpacing } from './text.mjs';

export const LIVE_PAUSE_MS = 5 * 60 * 1000;
const HANDS_ON_SECONDS = 3; // 使用者這麼久內碰過鍵盤滑鼠：對不上就是他在改

// 預覽的句尾標點先不打：講下去就要改掉，準的字回來會補上
const TRAILING = /[\s。．.!！?？,，、；;：:]+$/u;
const livePiece = (text) => String(text ?? '').trim().replace(TRAILING, '');
const ending = (text) => text.match(TRAILING)?.[0] ?? '';

// 預覽有沒有涵蓋整句：不算標點、空白，字數到準的字的七成。電腦卡住時預覽會少一截，這時才換成準的字，不然字缺一塊要等整理才補上
const bare = (text) => String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const covers = (preview, sentence) => bare(preview).length >= bare(sentence).length * 0.7;

// 兩段字開頭一樣的長度（不切在 emoji 這類兩格的字中間）
function samePrefix(a, b) {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a[n] === b[n]) n += 1;
  if (n > 0 && /[\uD800-\uDBFF]/.test(a[n - 1])) n -= 1;
  return n;
}

// 我們的字大致還在、只有後面幾個字不一樣：回傳框裡實際的那段，不像就回 null
function drifted(before, expect) {
  let at = -1;
  let longest = 0;
  for (let p = Math.max(0, before.length - expect.length - 8); p < before.length; p += 1) {
    const n = samePrefix(before.slice(p), expect);
    if (n > longest) {
      longest = n;
      at = p;
    }
  }
  return longest >= 4 && longest >= expect.length * 0.6 ? before.slice(at) : null;
}

export function createDraftWriter({ rewrite, commands = () => false, log = () => {}, now = () => Date.now() }) {
  let chain = []; // 游標前面還沒定案的草稿（一段一份），照框裡的順序
  let live = []; // 接在草稿後面、還在講（或還在轉）的那幾句的預覽：[{ turn, text }]
  let open = null; // 還沒講完的這段：{ raw：轉好的字, unwritten：還沒進框的字, unwrittenRaw：那些字準的樣子, draft：這段的草稿 }
  let base = ''; // 我們寫的字前面原本的字
  let where = null;
  const wanted = new Map(); // 第幾句 → 最新的預覽（排隊的時候只做最新的）
  const lost = new Map(); // 第幾句 → acted（使用者動了：準的字不寫）| unknown（看不出來：準的字照寫）
  let finalUpTo = 0; // 準的字回來（或不算）的最後一句：比它舊的預覽不再打
  let blockedTurn = 0; // 這句的預覽寫不進去（游標不在框裡…）：這句不再試
  let liveOffUntil = 0;
  let adding = 0;
  let queue = Promise.resolve();

  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  const joined = (list) => list.map((x) => x.text).join('');
  const tail = () => joined(chain) + joined(live);
  const trim = () => {
    while (chain[0]?.gone) base = (base + chain.shift().text).slice(-2000);
  };

  // 把框裡我們寫的字改成 next：只改開頭以後不一樣的部分
  async function apply(next, why) {
    const expect = tail();
    if (next === expect) return { ok: true };
    const send = async (from) => {
      const same = samePrefix(from, next);
      try {
        return (await rewrite({ expect: from, same, text: next.slice(same), where: expect ? where : null, why })) ?? { ok: false, reason: 'no-reply' };
      } catch (err) {
        return { ok: false, reason: err?.message ?? String(err) };
      }
    };
    let result = await send(expect);
    const handsOff = (result.idle ?? Infinity) >= HANDS_ON_SECONDS;
    const actual = result.reason === 'mismatch' && handsOff ? drifted(result.before ?? '', expect) : null;
    if (actual !== null) {
      log(`框裡的字有幾個不是我們寫的、也沒有人碰：改回來（${actual.slice(-30)}）`);
      const again = await send(actual);
      if (again.ok) result = again;
    }
    if (result.ok && !expect) {
      base = result.before ?? '';
      where = result.where ?? null;
    }
    return result;
  }

  // 對不上或寫不進去：框裡我們寫的字都不再改。使用者自己動了（框清空、我們的字還在但後面多了字、剛碰過鍵盤滑鼠）還是看不出來
  function letGo(result) {
    const expect = tail();
    const before = result.before ?? '';
    const acted = result.reason !== 'mismatch' || !before || before.includes(expect.slice(-20)) || (result.idle ?? Infinity) < HANDS_ON_SECONDS;
    for (const e of live) lost.set(e.turn, acted ? 'acted' : 'unknown');
    for (const d of chain) d.gone = true;
    chain = [];
    live = [];
    base = '';
    where = null;
    if (!acted && expect) {
      liveOffUntil = now() + LIVE_PAUSE_MS;
      log(`框裡的字跟寫進去的對不上（這個 app 可能會改字的樣子），5 分鐘內不邊講邊打：${before.slice(-30)}`);
    }
    return acted;
  }

  const ensureDraft = () => {
    if (open.draft) return open.draft;
    open.draft = { text: '', raw: '', before: (base + joined(chain)).slice(-1500), where, gone: false, writtenAt: 0 };
    chain.push(open.draft);
    return open.draft;
  };

  // 比這句舊、等不到準的字的預覽（轉寫失敗）：字留在框裡，當成這段的字。回傳這些字，App 要併進這段（AI 整理才看得到）
  function keepStale(turn) {
    const stale = live.filter((e) => e.turn < turn);
    if (!stale.length) return '';
    open ??= { raw: '', unwritten: '', unwrittenRaw: '', draft: null };
    const text = joined(stale);
    const draft = ensureDraft();
    draft.text += text;
    draft.raw += text;
    open.raw += text;
    live = live.filter((e) => e.turn >= turn);
    return text;
  }

  async function removeLive(turn) {
    if (!live.some((e) => e.turn === turn)) return;
    const rest = live.filter((e) => e.turn !== turn);
    const result = await apply(joined(chain) + joined(rest), 'drop');
    if (result.ok) live = rest;
    else letGo(result);
  }

  async function typePreview(turn) {
    const text = wanted.get(turn);
    wanted.delete(turn);
    if (text === undefined || turn <= finalUpTo || turn === blockedTurn || lost.has(turn) || now() < liveOffUntil) return;
    const piece = livePiece(text);
    if (!isSpeech(piece) || onlyFiller(piece)) return;
    if (commands() && isExplicitCommand((open?.raw ?? '') + piece)) return;
    if (live.some((e) => e.turn > turn)) return; // 後面那句已經在打了，這句舊的預覽不用再改
    const has = live.some((e) => e.turn === turn);
    const next = has ? live.map((e) => (e.turn === turn ? { turn, text: piece } : e)) : [...live, { turn, text: piece }];
    const result = await apply(joined(chain) + joined(next), 'preview');
    if (result.ok) {
      live = next;
      return;
    }
    // 對不上、游標換到別的框：使用者動了。游標不在框裡、選取了字、換了 app：這句先不打，講完寫準的字的時候再試（會對焦回原本的框）
    if (['mismatch', 'moved'].includes(result.reason)) letGo(result);
    else blockedTurn = turn;
  }

  // 回傳 { written：這句進框了, restart：這段前面的字不再算這段（App 要把它們從這段拿掉）, dropped：這句不算（已經送出），
  //   kept：框裡留著的這句預覽（準的字沒寫，等整理好一次換掉） }
  async function writeSentence(sentence, turn) {
    const piece = withSpacing(sentence);
    const state = lost.get(turn);
    for (const k of [...lost.keys()]) if (k <= turn) lost.delete(k);
    let restart = false;
    if (open?.draft?.gone) {
      open = null;
      restart = true;
    }
    if (state === 'acted') return { written: false, restart, dropped: true };
    open ??= { raw: '', unwritten: '', unwrittenRaw: '', draft: null };
    open.raw += piece;
    if ((commands() && isExplicitCommand(open.raw)) || onlyFiller(sentence)) {
      await removeLive(turn);
      return { written: false, restart };
    }
    // 這句的預覽已經在框裡、沒有少一截：留著預覽只補句尾標點，框裡的字等整理好才換（只換一次）
    const shown = live.find((e) => e.turn === turn);
    const kept = shown && covers(shown.text, sentence) ? shown.text : null;
    open.unwritten += kept !== null ? kept + ending(piece) : piece;
    open.unwrittenRaw += piece;
    let result = await apply(joined(chain) + open.unwritten + joined(live.filter((e) => e.turn !== turn)), 'sentence');
    if (!result.ok) {
      const acted = letGo(result);
      // 框裡的預覽不再算我們的：之後要寫就寫準的字
      open.unwritten = open.unwrittenRaw;
      if (open.draft) {
        open = { raw: piece, unwritten: piece, unwrittenRaw: piece, draft: null };
        restart = true;
      }
      // 這句的預覽已經在框裡，使用者動了（送出了）：這句就是他要的，準的字不再寫
      if (shown && acted) {
        open.raw = open.raw.slice(0, -piece.length);
        open.unwritten = open.unwritten.slice(0, -piece.length);
        open.unwrittenRaw = open.unwritten;
        if (!open.raw) open = null;
        return { written: false, restart, dropped: true };
      }
      // 寫不進去（游標不在框裡…）：照原本整理好才寫。對不上：寫在游標現在的地方，重新開始一份
      if (result.reason !== 'mismatch') return { written: false, restart };
      result = await apply(open.unwritten, 'sentence');
      if (!result.ok) return { written: false, restart };
    }
    live = live.filter((e) => e.turn !== turn);
    const draft = ensureDraft();
    const keptNow = open.unwritten !== open.unwrittenRaw;
    draft.text += open.unwritten;
    draft.raw += open.unwrittenRaw;
    draft.writtenAt = now();
    open.unwritten = '';
    open.unwrittenRaw = '';
    return keptNow ? { written: true, restart, kept } : { written: true, restart };
  }

  async function addSentence(sentence, turn) {
    const stale = keepStale(turn);
    const result = await writeSentence(sentence, turn);
    return stale && !result.restart ? { ...result, stale } : result;
  }

  // 回傳 'ok'（換好了）、'same'（字一樣不用換）、'gone'（早就不再換），其他是對不上的原因（之後也不再換）
  const settle = (draft, text) => serial(async () => {
    if (draft.gone) return 'gone';
    let outcome = 'same';
    if (text !== draft.text) {
      const at = chain.indexOf(draft);
      const result = await apply(joined(chain.slice(0, at)) + text + joined(chain.slice(at + 1)) + joined(live), 'settle');
      if (!result.ok) {
        letGo(result);
        return result.reason;
      }
      draft.text = text;
      outcome = 'ok';
    }
    draft.gone = true;
    trim();
    return outcome;
  });

  return {
    preview(turn, text) {
      if (turn <= finalUpTo) return;
      const queued = wanted.has(turn);
      wanted.set(turn, text);
      if (!queued) void serial(() => typePreview(turn));
    },
    add(sentence, turn = finalUpTo + 1) {
      finalUpTo = Math.max(finalUpTo, turn);
      adding += 1;
      return serial(() => addSentence(sentence, turn)).finally(() => { adding -= 1; });
    },
    drop(turn = finalUpTo + 1) {
      finalUpTo = Math.max(finalUpTo, turn);
      return serial(async () => {
        lost.delete(turn);
        await removeLive(turn);
      });
    },
    close() {
      const draft = open?.draft ?? null;
      open = null;
      return draft;
    },
    settle,
    // 這份不換了（換了 app、等太久），字留在框裡
    forget(draft) {
      draft.gone = true;
      trim();
    },
    /** 還沒講完的這段的草稿（沒有就是 null） */
    current: () => open?.draft ?? null,
    /** 框裡有這次講的字（草稿或邊講邊打的預覽） */
    typing: () => live.length > 0 || !!open?.draft,
    /** 有句子正在寫（寫完才算進這段，這時候不能算一段講完） */
    busy: () => adding > 0,
  };
}
