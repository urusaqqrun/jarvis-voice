// JarvisVoice 核心：聲紋過濾——只轉寫使用者自己的聲音（咖啡店裡別人講話、影片的聲音不轉寫、不貼）。
// 聲紋（speaker embedding）由呼叫端算（Mac 用 sherpa-onnx 的 CAM++ 中文模型），這裡只放比對規則：錄樣本、判斷、越用越準。
//
// 聲紋在背景自己學，沒有「建立聲紋」這一步（10/26 使用者定：整個是自動化的流程，一開始沒有建立聲紋）：
//   開了就照常轉寫，前面講的話順便當樣本（還沒學好時每句都放行），學夠了自動開始擋別人的聲音。
//   所以核心不給「還要講幾秒」：各 App 不顯示建立中、進度，也不另外做錄樣本的畫面；畫面只在擋掉別人的話時說一聲。
//
// 10/19 實測（CAM++ zh-cn、使用者自己的錄音 208 段、別人 234 段）：
//   - 同一支麥克風：自己對樣本 5%～95% 是 0.26～0.78，別人最高 0.27。
//   - 同一個地方錄樣本、同一個地方用（咖啡店）：自己的短句「你好，你好，你好」0.75、「哎呀，累」0.77，別人的「發言」0.24、雜音 0.20～0.31。
//   - 換了麥克風，自己只剩 0.2～0.4：樣本要用同一支麥克風錄（Mac 用平常收音的那支，第一次開就從講話裡錄；CubeLV 每支麥克風各一份）。
//   - 旁邊有人講話（別人音量是自己的 1/3～1/2）：門檻 0.3 自己被擋 9～16%。
//
// 手機不裝模型（CubeLV、平行沙盒）：聲紋由轉寫的後端算（同一個 CAM++ 模型），規則照樣在這裡、跑在前端——
// 前端把 gate()（參考聲紋＋門檻）交給後端，後端每句照 passesGate 擋；每句的聲紋送回前端，由 createRemoteVoiceprint 記樣本、越用越準。
// 計劃：CubeLV cubelv_docs/計劃/2026-10-19_只聽我的聲音_後端聲紋.md
//
// 門檻長句 0.3、短句 0.4 打底，同一場講話裡跟著你的分數往上提（10/19，CubeLV cubelv_docs 計劃/2026-10-19_聲紋門檻依個人自動調.md）：
//   - 同一場（10 分鐘內）很確定是你的長句（0.5 以上）滿 3 句後，門檻＝最近 5 句分數的中位數 − 0.45，夾在 [0.3, 0.5]；短句門檻＝max(0.4, 這個門檻)。
//     漏網的旁人（0.3～0.47）不記：箱子手機實測背景有人講話時你的分數掉到 0.74，漏網的 fangjun 0.36 一記進來門檻就一路往下掉。
//     換了地方、隔了一陣子再講，頭幾句照樣用 0.3，換環境分數整段掉下來也不會被卡住。
//   - 為什麼：同一場裡你的分數很穩（Mac 10/19 下午真的有字的長句 0.65～0.90、短句 0.58～0.79），聲音像你的旁人在 0.3～0.47，
//     固定 0.3 擋不住；門檻跟著你這場的分數走就擋得住。
//   - Mac 10/19 下午實際紀錄：放行的長句裡 0.32～0.40、短句 0.40～0.50 那幾句轉出來都是空的（爆音、雜音）。照這條重算，多擋的只有一句 0.32 的空句，有字的句子一句都不會多擋。
//   - 箱子模擬（Mac 那批 10 段錄音，有內容的本人句子）：本人被擋不變（長句 2.8%，被擋的是很小聲含糊、夾店員聲音那幾句），
//     雷軍講話中穿插劉德華、fangjun（同一批錄音條件、聲音像）通過 38.5% → 7.7%。
//   - 10/19 也試過：放寬到 0.2／0.05（同場旁人大多會過）、依個人往上調（比對群、跨場次的分數，換場次本人被擋變多），都不採用。
//
// 「這是我的話」（confirm）：被擋掉的那句，使用者說是他講的（App 聽寫列的按鈕，那句的字另外補回去，見 core/transcription.mjs 的 claim）：
//   - 分數連打底門檻都不到：參考聲紋跟你現在的聲音對不上（學錯了、換了環境或麥克風），從這句重學——舊的樣本丟掉，
//     這句當第一個樣本，接下來講的話照常轉寫、順便錄樣本，湊滿 10 秒自動學好（跟偏好設定的重錄一樣，不用另外去按）。
//     11/06 user 在平行沙盒回報時自己的三句 0.16、0.26、0.20 全被擋（舊聲紋學錯了），自己去重錄之後馬上 0.66、0.84。
//   - 有到打底、只是被這一場往上提的門檻（或短句門檻）擋掉：這句加進「最近的聲音」，這一場（10 分鐘）的門檻不高過這句的分數減 0.05，
//     長句短句都是，但不低於打底 0.3（旁人最高 0.27）。

export const VOICEPRINT_THRESHOLD = 0.3;
export const VOICEPRINT_MIN_SECONDS = 1.5; // 比這短的句子用 VOICEPRINT_SHORT_THRESHOLD
export const VOICEPRINT_SHORT_THRESHOLD = 0.4;
// 錄樣本要收到這麼多秒的講話：實測 3 秒自己被擋 19%、5～10 秒約 1 成、10 秒以上沒有再變好
export const ENROLL_SECONDS = 10;
const ENROLL_MIN_TURN = 1; // 錄樣本只收 1 秒以上的句子
const ENROLL_CLUSTER = 0.45; // 錄樣本時，跟大多數句子像到這個程度才算同一個人（混進來的別人剔除）
const ADAPT_MIN = 0.5; // 很確定是自己（而且 2 秒以上）的句子加進「最近的聲音」，聲音隨環境、時間變也跟得上
const ADAPT_SECONDS = 2;
const ADAPT_KEEP = 10;
const SESSION_MS = 10 * 60 * 1000; // 同一場：最近 10 分鐘內很確定是你的長句（ADAPT_MIN 以上）
const SESSION_MIN = 3; // 滿這麼多句才跟著這場的分數走
const SESSION_KEEP = 5; // 看最近這麼多句的中位數
const SESSION_DELTA = 0.45; // 門檻＝中位數減這麼多
const SESSION_CAP = 0.5;
const CLAIM_MARGIN = 0.05; // 「這是我的話」：這一場的門檻不高過那句的分數減這麼多
// 後端算聲紋用的模型（sherpa-onnx 3dspeaker_speech_campplus_sv_zh-cn_16k-common）：存檔記著，換了模型就重錄
export const REMOTE_VOICEPRINT_MODEL = 'campplus-zh-cn-16k-common';

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

// 幾個聲紋的平均（照秒數加權），再正規化
export function meanVector(items) {
  if (!items.length) return null;
  const m = new Array(items[0].v.length).fill(0);
  for (const { v, sec = 1 } of items) v.forEach((x, i) => { m[i] += x * sec; });
  return normalize(m);
}

// 錄樣本收到的幾句裡，挑彼此最像的那群：先找跟其他句子平均最像的那句，再留下跟它那群夠像的
export function pickEnrollment(items) {
  if (items.length < 2) return items;
  let best = items[0];
  let bestScore = -Infinity;
  for (const a of items) {
    const score = items.reduce((s, b) => s + (a === b ? 0 : cosine(a.v, b.v) * b.sec), 0);
    if (score > bestScore) { bestScore = score; best = a; }
  }
  const near = items.filter((x) => x === best || cosine(x.v, best.v) >= ENROLL_CLUSTER);
  const center = meanVector(near);
  return items.filter((x) => cosine(x.v, center) >= ENROLL_CLUSTER);
}

// 後端照這條擋（CubeLV ai_prompt、平行沙盒 control 各寫一份同樣的判斷）：沒有擋法（還在錄樣本）、算不出聲紋都放行；
// 短句用短句的門檻。跟 judge() 的放不放行一樣。
export function passesGate(gate, score, sec) {
  if (!gate || score === null || score === undefined) return true;
  return score >= (sec < gate.minSeconds ? gate.shortThreshold : gate.threshold);
}

// state：{ enrolled: [聲紋], recent: [聲紋], pending: [{ v, sec }], session: [{ at, score }] }（存檔用，聲紋是一般陣列）
// threshold、shortThreshold 是打底的門檻；這一場實際用多少看 threshold()、gate()。now 給測試換時鐘。
export function createVoiceprint({ state = {}, threshold = VOICEPRINT_THRESHOLD, minSeconds = VOICEPRINT_MIN_SECONDS, shortThreshold = VOICEPRINT_SHORT_THRESHOLD, now = () => Date.now() } = {}) {
  let enrolled = state.enrolled ?? [];
  let recent = state.recent ?? [];
  let pending = state.pending ?? [];
  let session = state.session ?? [];
  let claims = state.claims ?? []; // 這一場你說「這是我的話」的那幾句的分數：門檻不高過它
  let ref = null;
  // 「這是我的話」壓住的門檻：10 分鐘內按過的句子裡最低的分數 − 0.05，不低於打底；沒按過是 Infinity
  const claimCap = () => {
    const t = now();
    const scores = claims.filter((x) => t - x.at <= SESSION_MS).map((x) => x.score);
    return scores.length ? Math.max(threshold, Math.min(...scores) - CLAIM_MARGIN) : Infinity;
  };
  // 這一場的長句門檻：10 分鐘內很確定是你的長句滿 3 句，最近 5 句的中位數 − 0.45，夾在 [threshold, 0.5]；按過「這是我的話」就不高過那句
  const current = () => {
    const t = now();
    const scores = session.filter((x) => t - x.at <= SESSION_MS).slice(-SESSION_KEEP).map((x) => x.score).sort((a, b) => a - b);
    const raised = scores.length < SESSION_MIN
      ? threshold
      : Math.min(Math.max(SESSION_CAP, threshold), Math.max(threshold, scores[Math.floor(scores.length / 2)] - SESSION_DELTA));
    return Math.min(raised, claimCap());
  };
  const currentShort = () => Math.max(Math.min(shortThreshold, claimCap()), current());
  const refresh = () => {
    ref = meanVector([...enrolled.map((v) => ({ v, sec: 2 })), ...recent.map((v) => ({ v, sec: 1 }))]);
  };
  refresh();
  const pendingSeconds = () => pending.reduce((s, x) => s + x.sec, 0);
  // 錄樣本：收 1 秒以上的句子，湊滿 10 秒（3 句以上）就挑彼此最像的那群當樣本
  const collect = (v, sec) => {
    if (sec >= ENROLL_MIN_TURN) pending.push({ v: Array.from(v), sec });
    if (pendingSeconds() >= ENROLL_SECONDS && pending.length >= 3) {
      const picked = pickEnrollment(pending);
      if (picked.reduce((s, x) => s + x.sec, 0) >= ENROLL_SECONDS * 0.6) {
        enrolled = picked.map((x) => x.v);
        pending = [];
        refresh();
        return { pass: true, verdict: 'enrolled', score: 1, kept: picked.length };
      }
      pending = picked; // 太多句不像同一個人：只留像的那群，繼續收
    }
    return { pass: true, verdict: 'enrolling', score: null };
  };

  return {
    enrolled: () => enrolled.length > 0,
    // 一句講完：v 是這句的聲紋（正規化過），sec 是秒數。回傳 { pass, verdict, score }
    //   verdict：enrolling（還在錄樣本，照常轉寫）、enrolled（這句湊滿樣本）、short（短句，用短句的門檻放行）、mine、other
    // dryRun：只看不記（講到一半停頓時先比一下，不把半句算進樣本、不加進最近的聲音）
    judge(v, sec, { dryRun = false } = {}) {
      if (dryRun) {
        if (!enrolled.length) return { pass: true, verdict: 'enrolling', score: null };
        const score = cosine(v, ref);
        const th = sec < minSeconds ? currentShort() : current();
        if (score < th) return { pass: false, verdict: 'other', score };
        return { pass: true, verdict: sec < minSeconds ? 'short' : 'mine', score };
      }
      if (!enrolled.length) return collect(v, sec);
      const score = cosine(v, ref);
      if (sec < minSeconds) { const th = currentShort(); return { pass: score >= th, verdict: score >= th ? 'short' : 'other', score }; }
      if (score < current()) return { pass: false, verdict: 'other', score };
      // 這一場：很確定是你的長句（0.5 以上）分數記下來，門檻跟著走。漏網的旁人（0.3～0.47）不記，不會把門檻往下拉
      if (score >= ADAPT_MIN) session = [...session.filter((x) => now() - x.at <= SESSION_MS), { at: now(), score: Math.round(score * 1e4) / 1e4 }].slice(-SESSION_KEEP);
      // 越用越準：很確定是自己的句子（2 秒以上、0.5 以上）加進「最近的聲音」。只收 0.5 以上：漏網的旁人（多在 0.3～0.46）不會混進來。
      if (score >= ADAPT_MIN && sec >= ADAPT_SECONDS) {
        recent = [...recent, Array.from(v)].slice(-ADAPT_KEEP);
        refresh();
      }
      return { pass: true, verdict: 'mine', score };
    },
    // 「這是我的話」：被擋掉的那句（v、秒數、當時跟參考聲紋的分數）使用者說是他講的（規則見檔頭）。回傳 relearn：從這句重學
    confirm(v, sec, score) {
      if (!enrolled.length) { collect(v, sec); return { relearn: false }; }
      if (score === null || score === undefined || score < threshold) {
        enrolled = [];
        recent = [];
        pending = [];
        session = [];
        claims = [];
        ref = null;
        collect(v, sec);
        return { relearn: true };
      }
      recent = [...recent, Array.from(v)].slice(-ADAPT_KEEP);
      refresh();
      claims = [...claims.filter((x) => now() - x.at <= SESSION_MS), { at: now(), score: Math.round(score * 1e4) / 1e4 }];
      return { relearn: false };
    },
    // 這一場的長句門檻
    threshold: current,
    // 給後端的擋法：參考聲紋（樣本＋最近的聲音的平均）與這一場的門檻；還在錄樣本是 null。參考聲紋變了才會換成新的陣列
    gate: () => (enrolled.length ? { reference: ref, threshold: current(), shortThreshold: currentShort(), minSeconds } : null),
    reset() {
      enrolled = [];
      recent = [];
      pending = [];
      session = [];
      claims = [];
      ref = null;
    },
    state: () => ({ enrolled, recent, pending, session, claims }),
  };
}

// createRemoteVoiceprint —— 前端用（手機不裝模型）：聲紋由轉寫的後端每句算好送回來（voiceprint.turn），這裡記樣本、越用越準、存檔。
//   store：{ load() → 存過的（沒有是 null）, save(存檔), clear() }。存哪由各 app 決定（CubeLV：裝置本機，每個帳號、每支麥克風一份）。
//   onChange({ enrolled, pass, verdict, score })：每句判斷完（畫面只拿來說略過了幾句；還在學、剛學好都不顯示）。
//   transcription.onClaim(event)：「這是我的話」，被擋掉的那句記成你的（核心的 claim 會叫，見 core/transcription.mjs）。
// 回傳的 transcription 交給 createSpeechTranscription／createTranscriber 的 voiceprint 選項。
const gateChanged = (before, after) => after?.reference !== before?.reference || after?.threshold !== before?.threshold || after?.shortThreshold !== before?.shortThreshold;

export function createRemoteVoiceprint({ store, onChange = () => {}, ...opts }) {
  let saved = null;
  try { saved = store.load(); } catch { /* 讀不到就重錄 */ }
  const vp = createVoiceprint({ ...opts, state: saved?.model === REMOTE_VOICEPRINT_MODEL ? saved : {} });
  const round = (v) => v.map((x) => Math.round(x * 1e4) / 1e4);
  const save = () => {
    const s = vp.state();
    try {
      store.save({
        model: REMOTE_VOICEPRINT_MODEL, at: Date.now(),
        enrolled: s.enrolled.map(round), recent: s.recent.map(round), pending: s.pending.map((x) => ({ v: round(x.v), sec: x.sec })), session: s.session, claims: s.claims,
      });
    } catch { /* 存不進去：下次重錄 */ }
  };
  const clear = () => {
    vp.reset();
    try { store.clear(); } catch { /* 本來就沒有 */ }
  };
  return {
    enrolled: () => vp.enrolled(),
    // 重錄：刪掉存的聲紋，從接下來講的話重新錄（正在轉寫的話，呼叫端再叫 updateVoiceprint() 把新的擋法送給後端）
    reset: clear,
    transcription: {
      config: () => vp.gate(),
      // 後端用的模型跟存檔的不一樣：存的聲紋比不了，重錄。回傳 true＝擋法變了，核心再送一次設定
      onReady(info) {
        if (!info?.model || info.model === REMOTE_VOICEPRINT_MODEL || !vp.enrolled()) return false;
        clear();
        return true;
      },
      // 一句的結果（後端放行或擋掉都會來）：有聲紋就記進樣本／最近的聲音／這一場的分數。回傳 true＝擋法變了（剛錄好、參考聲紋換新、這一場的門檻動了）
      onTurn(event) {
        const pass = event.pass !== false;
        if (!event.embedding?.length) {
          onChange({ enrolled: vp.enrolled(), pass, verdict: pass ? 'short' : 'other', score: event.score ?? null });
          return false;
        }
        const wasEnrolled = vp.enrolled();
        const before = vp.gate();
        const sessionBefore = vp.state().session;
        const r = vp.judge(normalize(event.embedding), event.seconds ?? 0);
        const changed = gateChanged(before, vp.gate());
        if (!wasEnrolled || changed || vp.state().session !== sessionBefore) save();
        onChange({ enrolled: vp.enrolled(), pass, verdict: pass ? r.verdict : 'other', score: event.score ?? r.score });
        return changed;
      },
      // 「這是我的話」：後端擋掉的那句（它的 voiceprint.turn）使用者說是他講的，記成你的聲音（createVoiceprint().confirm）。回傳 true＝擋法變了
      onClaim(event) {
        if (!event?.embedding?.length) return false;
        const before = vp.gate();
        vp.confirm(normalize(event.embedding), event.seconds ?? 0, event.score ?? null);
        save();
        return gateChanged(before, vp.gate());
      },
    },
  };
}
