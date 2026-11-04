// JarvisVoice 核心：草稿。轉好的字不等 AI 整理，先寫進輸入框；整理好再把那段換掉。想送就直接送，不用等。
//   add(一句)：接在游標後面，同一段的句子接成一份草稿。
//   close()：這段講完了，交出這段的草稿（沒寫進去就是 null，照原本整理好才寫）。
//   settle(草稿, 字)：整理好了，把草稿換成這些字（空字串＝拿掉）。
// 只換自己寫的字：游標前面已經不是草稿（送出了、自己改了、游標移走了、換了 app）就不動，這份和排在它後面的都不再換。
// 接頭：
//   write(text, expect) → { ok, continued, before, where }：把 text 寫在游標這裡。expect 是游標前面應該要有的字（還沒定案的草稿），
//     continued 回有沒有對上；before 是寫之前游標前的字（給 AI 當上下文，不然 AI 會以為草稿本來就在框裡）；where 由 App 自己記（哪個 app、哪個框）。
//     ok 是 false＝沒寫（游標不在框裡、選取了字、讀不到框…），這句照原本整理好才寫。
//   replace(old, text, draft) → 'ok' 或對不上的原因：游標前面正好是 old 才換成 text。
//   commands()：有沒有開語音指令（開頭講「指令」的這段一定是要操作，不寫草稿；其他指令要等 AI 判斷，判斷完再把草稿拿掉）。
// 寫和換都排隊一次做一件：都要先確認游標前面的字，不能交錯。

import { isExplicitCommand } from './flow.mjs';
import { onlyFiller, withSpacing } from './text.mjs';

export function createDraftWriter({ write, replace, commands = () => false, log = () => {}, now = () => Date.now() }) {
  let chain = []; // 游標前面還沒定案的草稿，照框裡的順序，最後一份緊貼游標
  let open = null; // 還沒講完的這段：{ raw：轉好的字, unwritten：還沒進框的字, draft：這段的草稿 }
  let adding = 0;
  let queue = Promise.resolve();

  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  const joined = (drafts) => drafts.map((d) => d.text).join('');
  const letGo = () => {
    for (const d of chain) d.gone = true;
    chain = [];
  };
  const trim = () => {
    while (chain[0]?.gone) chain.shift();
  };
  const fresh = (piece) => ({ raw: piece, unwritten: piece, draft: null });

  // 回傳 { written：這句進框了, restart：這段前面的字不再算這段（App 要把它們從這段拿掉） }
  async function addSentence(sentence) {
    const piece = withSpacing(sentence);
    let restart = false;
    if (open?.draft?.gone) {
      open = null;
      restart = true;
    }
    open ??= { raw: '', unwritten: '', draft: null };
    open.raw += piece;
    if (commands() && isExplicitCommand(open.raw)) return { written: false, restart };
    if (onlyFiller(sentence)) return { written: false, restart };
    open.unwritten += piece;
    let result = null;
    try {
      result = await write(open.unwritten, joined(chain));
    } catch (err) {
      log(`草稿寫不進去：${err?.message ?? err}`);
    }
    if (!result?.ok) {
      if (open.draft) {
        open.draft.gone = true;
        trim();
        open = fresh(piece);
        restart = true;
      }
      return { written: false, restart };
    }
    if (!result.continued) {
      letGo();
      if (open.draft) {
        open = fresh(piece);
        restart = true;
      }
    }
    if (!open.draft) {
      open.draft = { text: '', before: result.before ?? '', where: result.where, gone: false, writtenAt: 0 };
      chain.push(open.draft);
    }
    open.draft.text += open.unwritten;
    open.draft.writtenAt = now();
    open.unwritten = '';
    return { written: true, restart };
  }

  // 回傳 'ok'（換好了）、'same'（字一樣不用換）、'gone'（早就不再換），其他是 replace 回的原因（對不上，之後也不再換）
  const settle = (draft, text) => serial(async () => {
    if (draft.gone) return 'gone';
    // 這段整理時又多寫了下一段的草稿：連後面的一起選起來換，換完游標還是在最後面
    const later = joined(chain.slice(chain.indexOf(draft) + 1));
    let outcome = 'same';
    if (text !== draft.text) {
      try {
        outcome = await replace(draft.text + later, text + later, draft);
      } catch (err) {
        outcome = err?.message ?? 'failed';
      }
      if (outcome !== 'ok') {
        letGo();
        return outcome;
      }
      draft.text = text;
    }
    draft.gone = true;
    trim();
    return outcome;
  });

  return {
    add(sentence) {
      adding += 1;
      return serial(() => addSentence(sentence)).finally(() => { adding -= 1; });
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
    /** 有句子正在寫（寫完才算進這段，這時候不能算一段講完） */
    busy: () => adding > 0,
  };
}
