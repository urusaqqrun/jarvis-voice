// JarvisVoice 核心：講話時那個小框（Mac 是游標旁的小框，CubeLV 是頂端的 toast）有哪些階段、寫什麼字、停多久。
// 各 App 只負責畫：bubbleContent 回 { title, body, tone, loud, busy, result, holdMs }。
// 階段（state）：
//   hearing：講話中，text 是聽到的字；speaker 是聲紋比對（mine 你說的、short 短句）。
//            聲紋還在背景學的時候不標、也不說還要講多久（core/voiceprint.mjs：沒有建立聲紋這一步）；
//   ignored：聲紋不像你、這句不轉寫（text 是預覽聽到的字；CubeLV 一直聽不跳，見 segment.mjs speechBubble 的 confirmedOnly）；
//   working：整理中（text 是轉寫原稿）；pasted：已貼上；
//   command：語音指令（text 是目標，detail 是做到哪一步，見 stepText）；done：指令完成；failed：指令沒完成（detail 是原因）；
//   nofield：自己找也找不到可以寫的地方，這段沒寫（detail 是 App 給的補充，例如 Mac 的「複製上一句」）；error：出錯（text 是原因）；hide：收起來。
// tone：blue 聽著／整理中、green 已貼上／完成、orange 沒貼上／沒完成、red 出錯（Mac 畫成左邊的色條）。
// loud：標題要醒目（沒貼上、沒完成、出錯）；busy：標題旁轉一個小圈；result：結果（放游標上面、寬度重新量）；
// holdMs：顯示多久就收（null＝一直留著，聽著、整理中、指令做到一半；App 自己在很久沒新消息時收）。
// lang：zh（台灣正體）、en、ja；認不得的用 en。

// 指令完成只要看一眼就收（擋在畫面上很礙事）；沒完成、出錯要看得清楚原因，停久一點
export const BUBBLE_HOLD_MS = { pasted: 1400, done: 700, ignored: 2500, nofield: 3000, noplace: 3500, failed: 3500, error: 4000 };
export const BUBBLE_MAX_CHARS = 84; // 內文最多三行：一行約 30 個中文字，只留最後這麼多字，最新的字才一定看得到

const TEXT = {
  listening: ['聽著…', 'Listening…', '聞き取り中…'],
  heard: ['聽到', 'Hearing', '聞き取り'],
  mine: ['你說的', 'You said', 'あなたの声'],
  short: ['你說的（短句）', 'You said (short)', 'あなたの声（短い文）'],
  ignored: ['別人在講話，這句不轉寫', 'Someone else is talking; not transcribed', 'ほかの人の声なので文字にしません'],
  working: ['整理中', 'Cleaning up', '整理中'],
  pasted: ['已貼上', 'Pasted', '貼り付けました'],
  command: ['語音指令', 'Voice command', '音声コマンド'],
  done: ['指令完成', 'Command done', 'コマンド完了'],
  failed: ['指令沒完成', 'Command not done', 'コマンド未完了'],
  // 不提游標（10/26 使用者：手機上根本沒有游標；JarvisVoice 本來就會自己找框，找不到才說）
  nofield: ['找不到可以寫進去的地方，這段沒寫', "Couldn't find a place to write this", '書き込める場所が見つからなかったため、書き込んでいません'],
  // 「打開／進到／去」開頭、App 對不到地方（planOutput 的 navigate）：不寫字，說找不到
  noplace: ['找不到這個頁面', "Couldn't find that page", 'そのページが見つかりません'],
  error: ['出錯了', 'Something went wrong', 'エラーが発生しました'],
  step: ['第 {n} 步：', 'Step {n}: ', 'ステップ {n}：'],
};
const VERBS = {
  click: ['點', 'click', 'クリック'],
  fill: ['填字到', 'type into', '入力'],
  long_press: ['長按', 'long-press', '長押し'],
  press_key: ['按', 'press', '押す'],
  scroll: ['捲動', 'scroll', 'スクロール'],
  swipe: ['滑', 'swipe', 'スワイプ'],
  back: ['回上一頁', 'go back', '前の画面に戻る'],
  select: ['選', 'select', '選択'],
  wait: ['等畫面載入', 'wait', '読み込みを待つ'],
  go: ['打開', 'open', '開く'],
  open_page: ['打開', 'open', '開く'],
  right_click: ['按右鍵', 'right-click', '右クリック'],
  menu: ['選選單', 'choose menu', 'メニューを選ぶ'],
  open_app: ['打開', 'open', '開く'],
  open_url: ['打開', 'open', '開く'],
};

const index = (lang) => (/^zh/i.test(lang ?? '') ? 0 : /^ja/i.test(lang ?? '') ? 2 : 1);
const pick = (row, lang, n) => row[index(lang)].replace('{n}', String(n ?? ''));

export const clipHead = (text, max = BUBBLE_MAX_CHARS) => (text.length > max ? `…${text.slice(-max)}` : text);

// 指令做到哪一步（小框 command 的 detail）：runAgent 的 onStep({ n, action, target }) → 「第 1 步：點「Gmail」」
export function stepText({ n, action, target = '' }, lang = 'zh') {
  const verb = VERBS[action] ? pick(VERBS[action], lang) : action;
  // 中文名字用引號包起來時直接接在動詞後面（點「財務」），其他照舊空一格（點 按鈕「行事曆」、click e3）
  return `${pick(TEXT.step, lang, n)}${verb}${target ? `${/^[「（]/.test(target) ? '' : ' '}${target}` : ''}`;
}

export function bubbleContent(e, lang = 'zh') {
  const t = (key) => pick(TEXT[key], lang);
  const lines = (...parts) => parts.filter(Boolean).join('\n');
  const out = (title, body, tone, extra = {}) => ({
    title, body: body ? clipHead(body) : '', tone, loud: false, busy: false, result: false, holdMs: BUBBLE_HOLD_MS[e.state] ?? null, ...extra,
  });
  switch (e.state) {
    case 'hearing': {
      // 小標籤寫是誰講的（開了「只聽我的聲音」、聲紋學好了、這句比過才有）
      if (!e.text) return out(t('listening'), '', 'blue');
      const who = { mine: 'mine', short: 'short' }[e.speaker];
      return out(t(who ?? 'heard'), e.text, 'blue');
    }
    case 'ignored': return out(t('ignored'), e.text, 'orange', { loud: true });
    case 'working': return out(t('working'), e.text, 'blue', { busy: true });
    case 'pasted': return out(t('pasted'), '', 'green', { result: true });
    case 'command': return out(t('command'), lines(e.text, e.detail), 'blue', { busy: true });
    case 'done': return out(t('done'), e.text, 'green', { result: true });
    case 'failed': return out(t('failed'), lines(e.text, e.detail), 'orange', { loud: true });
    case 'nofield': return out(t('nofield'), e.detail, 'orange', { loud: true });
    case 'noplace': return out(t('noplace'), lines(e.text, e.detail), 'orange', { loud: true });
    case 'error': return out(t('error'), e.text, 'red', { loud: true });
    default: return null;
  }
}
