// JarvisVoice 核心：第三層：游標不在輸入框時，從視窗裡的輸入框挑一個寫進去。平常由決策器（Jev 或 AI）挑，這裡是沒有決策器時的規則：
// 這個視窗上次寫的那個優先；其次看標籤（Prompt、訊息、回覆……）、多行優先、越下面越大越像聊天輸入框。有能寫的框就一定挑一個。

const GOOD_LABEL = /prompt|message|訊息|reply|回覆|回應|comment|留言|compose|撰寫|輸入|write|ask|問|chat|聊天|內文|body|note|筆記/i;

// 只排掉寫不進去的：停用的、沒有大小的（看不到）；App 標了 outbound 的也不挑：一按送出就給別人的框（聊天室、留言、回信），
// 自動挑進去的話，沒被認成指令的一句話就變成寄給別人的訊息（CubeLV 團隊來信的回信框）。要寫進那種框，先點它（游標在框裡就不用挑）
export function usable(c) {
  return c.enabled !== false && !c.outbound && c.w >= 4 && c.h >= 4;
}

export function score(c, window) {
  let s = 0;
  if (GOOD_LABEL.test(c.label ?? '')) s += 100;
  if (c.role === 'AXTextArea') s += 40;
  if (window?.h) {
    s += Math.max(0, Math.min(1, (c.y + c.h - window.y) / window.h)) * 40; // 越下面越像聊天輸入框
    s += Math.min(30, ((c.w * c.h) / (window.w * window.h)) * 100); // 越大越像主要的編輯區
  }
  return s;
}

const sameField = (c, r) => c.role === r.role && (c.label ?? '') === (r.label ?? '')
  && (!r.frame || Math.abs(c.y - r.frame.y) < 80);

// 回傳 { choice, reason, sure, list }：choice 只有在視窗裡沒有輸入框時才是 null；
// sure 表示不用再問決策器（上次寫的那個、或只有一個）；list 是能寫的輸入框
export function rankTargets({ candidates = [], window = null, remembered = null }) {
  const list = candidates.filter(usable);
  if (!list.length) return { choice: null, reason: '視窗裡沒有輸入框', sure: true, list };
  if (remembered) {
    const again = list.find((c) => sameField(c, remembered));
    if (again) return { choice: again, reason: '這個視窗上次寫的地方', sure: true, list };
  }
  if (list.length === 1) return { choice: list[0], reason: '視窗裡只有這一個輸入框', sure: true, list };
  const ranked = list.map((c) => ({ c, s: score(c, window) })).sort((a, b) => b.s - a.s);
  return { choice: ranked[0].c, reason: '規則排第一的輸入框', sure: false, list };
}
