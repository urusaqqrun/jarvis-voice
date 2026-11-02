// JarvisVoice 核心：一段話講完之後怎麼處理。Mac 小程式、CubeLV、平行沙盒都照這一份規則，各 App 只給接頭
// （AI 整理、決策器、看畫面、找輸入框、寫進去）。
//   1. judgeUtterance：AI 整理，順便判斷是不是指令。
//   2. planOutput：整理完要做什麼——指令、刪掉剛剛那段、換回原文、只有語氣詞不寫、寫字、（App 開了 navigate 時）去某個地方。
//   3. pickTarget：游標不在輸入框時，挑一個寫進去的框。
// 不問使用者：拿不準就照 AI 整理的判斷；整理失敗照原稿寫；挑不到框由 App 決定（Mac 小框寫「沒貼上」、CubeLV 交給 CEO）。

import { describeElement, fieldQuestions, inFieldIntentQuestion, inFieldVerdict, referenceQuestion } from './decide.mjs';
import { rankTargets } from './targeter.mjs';

// 游標不在輸入框、AI 說是打字時，Jev 要這麼確定是指令才改當指令
export const NOT_IN_FIELD_SURE = 0.95;
const FIELD_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'];

// 游標在輸入框時問決策器（Jev）：看畫面上有什麼，判斷這句是不是要操作畫面。
// field：游標所在的框 { label, role }；回傳 inFieldVerdict 的結果，加上畫面是怎麼讀的（source：ocr、no-permission…）
export async function judgeInField({ raw, screen, decider, field = {}, context = {} }) {
  const snap = await screen.elements({ limit: 150, ocr: 'auto' });
  const items = (snap?.elements ?? []).filter((e) => !FIELD_ROLES.includes(e.role)).slice(0, 120);
  const where = [field.label, field.role].filter(Boolean).join('，');
  const answers = await decider.decide({
    transcript: raw, app: context.app ?? '', window: context.window ?? '', field: `${where}（游標在這）`,
    screen: items.map((e) => describeElement(e, snap?.window)),
  }, { intent: inFieldIntentQuestion(), target: referenceQuestion(items, snap?.window) });
  return { ...inFieldVerdict(answers, items), source: snap?.source };
}

// AI 整理＋是不是指令。edit(transcript) → editSegment 的結果（丟錯＝整理失敗）。
// 決策器只在有 Jev 時才問（App 給 judge／intent；沒有 Jev 給 null，就照 AI 整理的判斷）：
//   judge：游標在輸入框時 judgeInField 的 Promise；intent：游標不在輸入框時「是指令的機率」的 Promise（number 或 null）。
// 回傳 editSegment 的結果；null＝照原稿寫（AI 說是指令、Jev 看了畫面說不是）；{ failed }＝整理失敗（照原稿寫）。
// 是不是指令：
//   游標不在輸入框：照 AI 整理的判斷（實測只用 AI 40/40；再要 Jev 也同意，反而會擋掉「傳訊息給某人」）。
//     只有一個例外是單向的：AI 說是打字、Jev 很確定是要操作畫面（≥ NOT_IN_FIELD_SURE）時改當指令——同一句「開啟我的 email」
//     AI 有時判成打字，游標不在輸入框就會被貼進這個視窗上次寫的地方（10/19 貼進 Threads 的發文框）；
//   游標在輸入框：Jev 看了畫面很確定是要操作畫面才算（這時再請 AI 拆出目標和要搜尋的字）；
//     AI 說是指令但 Jev 說不是就當成打字，開頭講「指令」或傳訊息給某人除外。
//   沒有 Jev 就照 AI 整理的判斷（游標在輸入框時只有開頭講「指令」或傳訊息才算）。
export async function judgeUtterance({ raw, inField, edit, judge = null, intent = null, aborted = () => false, log = () => {} }) {
  try {
    let result = await edit(raw);
    const verdict = judge ? await judge : null;
    const jevNote = verdict ? `；Jev：是指令的機率 ${verdict.command.toFixed(2)}${verdict.named ? `，講到「${verdict.named.label}」` : ''}` : '';
    log(`AI 整理（${result.model ?? 'AI'}，${result.ms} ms，${result.mode}）：${result.mode === 'command' ? result.goal : result.text || '（無）'}${jevNote}`);
    if (result.keptRaw) log('AI 把不只語氣詞的話整理成空的：照原稿寫');
    if (result.mode === 'command' && verdict && !verdict.isCommand && !/^\s*(指令|command)/i.test(raw) && !result.message?.trim()) {
      log('AI 說是指令、Jev 說不是：當成要打的字，貼原稿');
      return null;
    }
    if (result.mode !== 'command' && intent) {
      const p = await intent;
      if (p !== null && p >= NOT_IN_FIELD_SURE) {
        const forced = await edit(`指令，${raw}`);
        if (forced.mode === 'command') {
          log(`游標不在輸入框，AI 說是打字、Jev 確定是要操作畫面（${p.toFixed(2)}）：當成指令（${forced.goal}）`);
          return forced;
        }
      } else if (p !== null) log(`游標不在輸入框，Jev 覺得是指令的機率 ${p.toFixed(2)}：照 AI 當成打字`);
    }
    if (result.mode !== 'command' && inField && verdict?.isCommand) {
      const forced = await edit(`指令，${raw}`);
      if (forced.mode === 'command') {
        log(`游標在輸入框，但 Jev 確定是要操作畫面：當成指令（${forced.goal}）`);
        result = forced;
      }
    }
    return result;
  } catch (err) {
    if (aborted()) return null; // 提早整理作廢了
    return { failed: err?.message ?? String(err) };
  }
}

// 開頭是「打開／進到／去」的短句：叫電腦去某個地方（頁面、分頁、入口）。回 { verb, target } 或 null。
// 「去年」「去掉」「去吃飯」這類不是要去哪裡；太長的是在講一件事，不是講地方的名字。
const NAV_VERB = /^(?:請|幫我|麻煩|我要|我想)?\s*(打開|開啟|進到|進入|前往|切到|切換到|跳到|回到|去到|去|open|go\s+to|go\s+back\s+to|switch\s+to)\s*/i;
const NOT_A_PLACE_AFTER_GO = /^(?:年|掉|過|除|世|吃|睡|玩|買|洗|做|找|跑|走|拿|接|上班|上課|上學|吧|了|嗎)/u;
const NAV_TARGET_MAX = 20;
export function navigationIntent(raw) {
  const text = String(raw ?? '').trim().replace(/[\s。．.!！?？，,、]+$/u, '');
  const m = text.match(NAV_VERB);
  if (!m) return null;
  const target = text.slice(m[0].length).replace(/^(?:我的|那個|一下|the\s+|my\s+)/iu, '').trim();
  if (!target || target.length > NAV_TARGET_MAX) return null;
  if (m[1] === '去' && NOT_A_PLACE_AFTER_GO.test(target)) return null;
  return { verb: m[1], target };
}

// 整理完要做什麼。result：judgeUtterance 的結果（AI 整理關著是 null）。
//   command：在畫面上做（操作代理 runAgent）；delete_last：刪掉剛剛寫的那段；revert_last：換回原文；
//   filler：整段只有語氣詞，不寫；write：寫字（text 是要寫的字，failed 有值＝整理失敗照原稿）。
//   navigate：App 開了 navigate（CubeLV：游標不在輸入框時）、這段又是「打開／進到／去」開頭的短句，AI 卻判成打字（例如「打開隨手記」
//     的隨手記已經改名、「打開手機」對不到地方）：不寫字，由 App 找那個地方，找不到就說找不到，不把這句寫進別的框。
export function planOutput({ raw, result, navigate = false }) {
  const nav = navigate && result?.mode !== 'command' ? navigationIntent(raw) : null;
  if (nav && (result?.failed || result?.mode === 'insert' || !result)) return { kind: 'navigate', target: nav.target, text: raw };
  if (result?.failed) return { kind: 'write', text: raw, mode: 'insert', ai: false, failed: result.failed };
  if (result?.mode === 'command') return { kind: 'command', result };
  if (result?.mode === 'delete_last') return { kind: 'delete_last' };
  if (result?.mode === 'revert_last') return { kind: 'revert_last' };
  if (result?.mode === 'insert' && !result.text.trim()) return { kind: 'filler' };
  const text = result ? result.text : raw;
  return { kind: 'write', text, mode: result?.mode ?? 'insert', ai: !!result && result.text !== raw, result };
}

// 游標不在輸入框：挑要寫進去的框。這個視窗上次寫的那個或只有一個就直接用，其他交給決策器（Jev 或 AI）挑，
// 沒有決策器就照規則排第一的。candidates：畫面上的輸入框（ScreenElement）；remembered：這個視窗上次寫的 { role, label, frame }。
// 回傳 { choice, reason } 或 null（視窗裡沒有輸入框）
export async function pickTarget({ candidates = [], window = null, remembered = null, transcript = '', decider = null, context = {}, log = () => {} }) {
  let { choice, reason, sure, list } = rankTargets({ candidates, window, remembered });
  if (!sure && decider?.available()) {
    try {
      const started = Date.now();
      const a = await decider.decide({ transcript, app: context.app ?? '', window: window?.title ?? '' }, fieldQuestions(list, window));
      const pick = list[Number(String(a.target?.choice ?? '').slice(1))];
      if (pick) {
        choice = pick;
        reason = `${decider.engine()} 挑的，信心 ${(a.target.confidence ?? 0).toFixed(2)}，${Date.now() - started} ms`;
      }
    } catch (err) {
      log(`決策器失敗，改照規則挑：${err.message}`);
    }
  }
  if (!choice) {
    log(`游標不在輸入框，${reason}`);
    return null;
  }
  return { choice, reason };
}
