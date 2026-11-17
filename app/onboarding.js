// 第一次打開的設定畫面：由 app/ui.js 讀進來執行（新裝、上次沒走完，或選單「設定精靈…」），呼叫它的
// t()、statePath()、fm()、brandImage()、startListener()、runModels()、setUpKey()；它的 let／const 在它自己的 eval 裡看不到，
// 狀態（view、models、settings…）從 uiState() 讀。
// 一頁一件事：歡迎 → 麥克風 → 輔助使用 → 本機辨識模型 → 講一句試試 → AI 整理（選用）→ 完成。
// 權限一給、模型一下載好就自己往下（每 0.5 秒看一次），已經好了的那一頁直接跳過。按「開始」就在背景下載模型，
// 走到那一頁通常已經好了。「講一句試試」才帶起常駐程式，並放 try-here：常駐程式平常不在自己的視窗收音，這一頁例外。
// 中途關掉視窗：常駐程式照樣帶起來；新裝的下次打開再出現（onboarding 檔還在），走完寫 onboarded。
ObjC.import('AVFoundation');
ObjC.import('ApplicationServices');
ObjC.import('ServiceManagement');

const OB_W = 560;
const OB_H = 352;
const OB_STEPS = 5; // 有編號的頁：麥克風、輔助使用、模型、試講、AI 整理（歡迎、完成不算）
const OB_ORDER = ['welcome', 'mic', 'ax', 'model', 'try', 'ai', 'done'];
let obWindow = null;
let obStep = '';
let obTimer = null;
let obMicTask = null; // 為了跳出麥克風詢問帶起的收音小幫手（聲音丟掉），問完就關
let obMicAsked = false;
let obAxAsked = false;
let obFinished = false;
const ob = {}; // 畫面上的元件：icon、title、body、bar、status、practice、check、primary、secondary
let obTestState = null; // 測試畫圖時蓋過 uiState() 的狀態
const S = () => (obTestState ? { ...uiState(), ...obTestState } : uiState());

// 麥克風權限：0 還沒問、1 受限制、2 拒絕、3 允許（AVCaptureDevice 在 JXA 要這樣拿）
function micStatus() {
  try { return Number($.NSClassFromString('AVCaptureDevice').authorizationStatusForMediaType($.AVMediaTypeAudio)); } catch (err) { return -1; }
}

const axTrusted = () => !!$.AXIsProcessTrusted();

function openPrivacyPane(anchor) {
  $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(`x-apple.systempreferences:com.apple.preference.security?${anchor}`));
}

function setTryHere(on) {
  const path = statePath('try-here');
  if (on) fm().createFileAtPathContentsAttributes(path, $(), $());
  else if (fm().fileExistsAtPath(path)) fm().removeItemAtPathError(path, null);
}

function stopMicHelper() {
  if (obMicTask) { try { obMicTask.terminate; } catch (err) { /* 已經結束 */ } }
  obMicTask = null;
}

function closeOnboardingTasks() {
  stopMicHelper();
  setTryHere(false);
}

// 登入 Mac 時自動打開（下載版才有；install.sh 裝的用 LaunchAgent）
function setLoginItem(on) {
  try {
    const service = $.SMAppService.mainAppService;
    if (on) service.registerAndReturnError(null);
    else service.unregisterAndReturnError(null);
  } catch (err) { uiLog(`登入時自動打開設定失敗：${err}`); }
}

// ── 每一頁的字：step 是第幾步；busy 狀態列前面轉圈；ok、error 狀態列變綠、變紅 ──
function obCopy(step) {
  switch (step) {
    case 'welcome': return {
      title: t('講話，就打進你正在用的 app', 'Talk, and it types into the app you’re using'),
      body: t('JarvisVoice 開著就在聽。在 Claude、ChatGPT、瀏覽器、LINE、備忘錄裡直接講，講完的話會自己打進游標所在的輸入框，不用按任何按鈕。\n\n接下來開兩個權限、講一句試試，大約一分鐘。',
        'JarvisVoice listens while it’s running. Just talk in Claude, ChatGPT, your browser, Notes or any app, and what you say is typed into the text field where your cursor is. No button to press.\n\nNext: two permissions and a quick test. It takes about a minute.'),
      primary: t('開始', 'Get Started'),
    };
    case 'mic': return micStatus() === 2 ? {
      step: 1, title: t('允許使用麥克風', 'Allow the microphone'),
      body: t('麥克風被關掉了。到「系統設定 → 隱私權與安全性 → 麥克風」把 JarvisVoice 打開，開好之後，這個視窗會自動跳到下一步。',
        'The microphone is turned off for JarvisVoice. Turn it on in System Settings → Privacy & Security → Microphone, and this window moves on by itself.'),
      primary: t('打開系統設定', 'Open System Settings'), secondary: t('略過', 'Skip'),
    } : {
      step: 1, title: t('允許使用麥克風', 'Allow the microphone'),
      body: t('JarvisVoice 要聽你講話。按下面的按鈕，系統詢問時選允許。\n\n用本機辨識時，聲音不會離開這台 Mac。',
        'JarvisVoice needs to hear you. Click the button below and allow access when macOS asks.\n\nWith on-device transcription, your audio never leaves this Mac.'),
      primary: t('允許麥克風', 'Allow Microphone'), secondary: t('略過', 'Skip'),
      status: obMicAsked ? t('等你在系統視窗按允許…', 'Waiting for you to allow access in the macOS prompt…') : '', busy: obMicAsked,
    };
    case 'ax': return {
      step: 2, title: t('允許 JarvisVoice 打字', 'Let JarvisVoice type for you'),
      body: t('要把字打進別的 app，macOS 需要你在「輔助使用」打開 JarvisVoice。\n\n按下面的按鈕，在打開的設定裡把 JarvisVoice 的開關打開，開好之後，這個視窗會自動跳到下一步。清單裡沒有 JarvisVoice？按下方的＋把它加進來。',
        'To type into other apps, macOS needs you to turn on JarvisVoice under Accessibility.\n\nClick the button below and turn on the switch next to JarvisVoice. This window moves on by itself once it’s on. Don’t see JarvisVoice? Click + and add it from Applications.'),
      primary: t('打開輔助使用設定', 'Open Accessibility Settings'), secondary: t('略過', 'Skip'),
      status: obAxAsked ? t('等你打開 JarvisVoice 的開關…', 'Waiting for the JarvisVoice switch to be turned on…') : '', busy: obAxAsked,
    };
    case 'model': {
      const failed = S().models.state === 'error';
      return {
        step: 3, title: t('下載本機辨識模型', 'Downloading the on-device model'),
        body: t('本機辨識免費，聲音不離開這台 Mac。模型共約 180 MB，只要下載一次。',
          'On-device transcription is free and keeps your audio on this Mac. The models are about 180 MB in total and download once.'),
        primary: failed ? t('再試一次', 'Try Again') : t('在背景下載，先繼續', 'Continue in Background'),
        secondary: failed ? t('先略過', 'Skip for Now') : '',
        status: obModelText(), bar: !failed, busy: !failed, error: failed,
      };
    }
    case 'try': return {
      step: 4, title: t('講一句試試', 'Say something'),
      body: t('直接講一句，例如「明天下午三點開會」。講完停一下，字就會打進下面的框。',
        'Just say a sentence, like “Let’s meet at three tomorrow.” Pause when you’re done, and the words will appear in the box below.'),
      primary: t('下一步', 'Next'), secondary: t('略過', 'Skip'), status: obTryText(), practice: true,
      busy: !obTried() && S().view.state === 'listening', ok: obTried(),
    };
    case 'ai': return {
      step: 5, title: t('要 AI 幫你整理嗎？（選用）', 'Want AI cleanup? (optional)'),
      body: t('AI 整理會拿掉「嗯、那個」和講錯改口，加上標點、排成條列，人名和專有名詞照畫面上的寫法打對。\n\n要用你自己的 OpenAI、DeepSeek 或 Claude 的 API key，一天講 1 小時，一個月不到 1 美元。之後也可以從選單列的圖示設定。',
        'AI cleanup removes ums and false starts, adds punctuation and lists, and spells names and terms the way they appear on screen.\n\nIt uses your own OpenAI, DeepSeek or Claude API key: under US$1 a month at an hour a day. You can also set it up later from the menu bar icon.'),
      primary: t('先不用', 'Not Now'), secondary: t('設定 API key…', 'Set Up API Key…'),
    };
    default: return {
      title: t('好了，去試試看', 'You’re all set'),
      body: t('打開 Claude、ChatGPT 或任何 app，點進輸入框直接講。\n\n螢幕右上角選單列的 {icon} 就是 JarvisVoice：可以暫停收音、切換辨識方式、設定 AI 整理。',
        'Open Claude, ChatGPT or any app, click into a text field and just talk.\n\nThe {icon} in the menu bar at the top right of your screen is JarvisVoice: use it to pause listening, switch transcription or set up AI cleanup.'),
      primary: t('完成', 'Done'), check: !!BUILD.bundled,
    };
  }
}

function obModelText() {
  const { models } = S();
  if (models.state === 'error') return t(`下載失敗：${models.message}`, `Download failed: ${models.message}`);
  if (models.state === 'done') return t('好了', 'Done');
  if (!models.total) return t('準備下載…', 'Starting the download…');
  const pct = Math.floor((models.done / models.total) * 100);
  const mb = (n) => (n / 1e6).toFixed(0);
  return models.model === 'speaker'
    ? t(`下載聲紋模型：${pct}%（${mb(models.done)} / ${mb(models.total)} MB）`, `Downloading the voice model: ${pct}% (${mb(models.done)} / ${mb(models.total)} MB)`)
    : t(`下載辨識模型：${pct}%（${mb(models.done)} / ${mb(models.total)} MB）`, `Downloading the speech model: ${pct}% (${mb(models.done)} / ${mb(models.total)} MB)`);
}

const obTried = () => !!ob.practice && ObjC.unwrap(ob.practice.string).trim().length > 0;

function obTryText() {
  if (obTried()) return t('成功了！在任何 app 都是這樣：游標在哪，字就打到哪。', 'It worked. It’s the same in any app: the words go wherever your cursor is.');
  const { models, view, hearing, working } = S();
  if (!axTrusted()) return t('還沒允許輔助使用，字打不進來：到「系統設定 → 隱私權與安全性 → 輔助使用」打開 JarvisVoice。',
    'Accessibility isn’t on yet, so nothing can be typed: turn on JarvisVoice in System Settings → Privacy & Security → Accessibility.');
  if (models.state !== 'done') return t(`本機辨識模型還在下載（${obModelText()}），好了就可以講。`, `The on-device model is still downloading (${obModelText()}). You can talk once it’s done.`);
  if (view.state === 'error') return t(`出錯：${view.message}`, `Error: ${view.message}`);
  if (view.state !== 'listening') return t('啟動中…', 'Starting…');
  if (working) return t('辨識中…', 'Transcribing…');
  if (hearing) return t('聽到了…', 'Hearing you…');
  return t('正在聽，直接講就好…', 'Listening… go ahead and talk.');
}

// ── 畫面 ──
// 版面：左右邊距 40；標誌、標題、內文由上往下排，進度條、試講框、勾選框、狀態排在內文下面，
// 按鈕右下、右緣對齊內容（520），第幾步在左下
const OB_LEFT = 40;
const OB_WIDTH = OB_W - 80;

function obLabel(size, weight, wrap) {
  const label = wrap ? $.NSTextField.wrappingLabelWithString('') : $.NSTextField.labelWithString('');
  label.setFont(weight ? $.NSFont.systemFontOfSizeWeight(size, weight) : $.NSFont.systemFontOfSize(size));
  return label;
}

const obDark = () => /Dark/.test(ObjC.unwrap(obWindow.effectiveAppearance.name));

// 內文：{icon} 換成選單列的 JarvisVoice 標誌（陌生人不知道選單列的圖示長什麼樣子）
function obSetBody(text) {
  if (!text.includes('{icon}')) { ob.body.setStringValue(text); return; }
  // JXA 叫不到 NSAttributedString 的 initWithString（class cluster）：先接字和圖示，最後整段套字型與顏色
  const out = $.NSMutableAttributedString.alloc.init;
  text.split('{icon}').forEach((part, i) => {
    if (i) {
      const mark = $.NSTextAttachment.alloc.init;
      const image = brandImage(0.9, obDark() ? $.NSColor.whiteColor : $.NSColor.blackColor);
      mark.setImage(image);
      mark.setBounds($.NSMakeRect(0, -3, image.size.width, image.size.height));
      out.appendAttributedString($.NSAttributedString.attributedStringWithAttachment(mark));
    }
    out.replaceCharactersInRangeWithString($.NSMakeRange(Number(out.length), 0), $(part));
  });
  out.addAttributesRange($.NSDictionary.dictionaryWithObjectsForKeys($([$.NSFont.systemFontOfSize(14), $.NSColor.secondaryLabelColor]),
    $([$.NSFontAttributeName, $.NSForegroundColorAttributeName])), $.NSMakeRange(0, Number(out.length)));
  ob.body.setAttributedStringValue(out);
}

function obBuild() {
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, OB_W, OB_H), 1 | 2, 2, false);
  win.setTitle('JarvisVoice');
  win.setReleasedWhenClosed(false);
  win.setDelegate(obController);
  const root = win.contentView;
  ob.icon = $.NSImageView.alloc.initWithFrame($.NSMakeRect(OB_LEFT - 2, OB_H - 28 - 40, 44, 40));
  ob.icon.setImage(brandImage(2.2));
  ob.icon.setContentTintColor($.NSColor.labelColor);
  ob.title = obLabel(22, 0.4, false);
  ob.body = obLabel(14, 0, true);
  ob.body.setTextColor($.NSColor.secondaryLabelColor);
  ob.bar = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(OB_LEFT, 0, OB_WIDTH, 12));
  ob.bar.setStyle(0);
  ob.bar.setIndeterminate(false);
  ob.bar.setMinValue(0);
  ob.bar.setMaxValue(1);
  ob.spinner = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(OB_LEFT, 0, 16, 16));
  ob.spinner.setStyle(1);
  ob.spinner.setControlSize(1);
  ob.spinner.setDisplayedWhenStopped(false);
  ob.status = obLabel(13, 0, true);
  ob.scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(OB_LEFT, 0, OB_WIDTH, 70));
  ob.scroll.setBorderType(2);
  ob.scroll.setHasVerticalScroller(true);
  ob.practice = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, OB_WIDTH - 4, 66));
  ob.practice.setRichText(false);
  ob.practice.setFont($.NSFont.systemFontOfSize(15));
  ob.practice.setTextContainerInset($.NSMakeSize(6, 6));
  ob.practice.setAutoresizingMask(2);
  ob.scroll.setDocumentView(ob.practice);
  ob.check = $.NSButton.checkboxWithTitleTargetAction(t('登入 Mac 時自動打開 JarvisVoice', 'Open JarvisVoice when you log in'), obController, null);
  ob.check.setState(1);
  ob.steps = obLabel(13, 0, false);
  ob.steps.setTextColor($.NSColor.secondaryLabelColor);
  ob.primary = $.NSButton.buttonWithTitleTargetAction('', obController, 'obPrimary:');
  ob.primary.setKeyEquivalent('\r');
  ob.secondary = $.NSButton.buttonWithTitleTargetAction('', obController, 'obSecondary:');
  for (const key of ['icon', 'title', 'body', 'bar', 'spinner', 'status', 'scroll', 'check', 'steps', 'primary', 'secondary']) root.addSubview(ob[key]);
  win.center;
  obWindow = win;
}

function obRender() {
  const copy = obCopy(obStep);
  ob.title.setStringValue(copy.title);
  ob.title.setFrame($.NSMakeRect(OB_LEFT, OB_H - 110, OB_WIDTH, 30));
  obSetBody(copy.body);
  ob.body.setPreferredMaxLayoutWidth(OB_WIDTH);
  const bodyH = Math.ceil(ob.body.fittingSize.height);
  let y = OB_H - 120 - bodyH;
  ob.body.setFrame($.NSMakeRect(OB_LEFT, y, OB_WIDTH, bodyH));
  ob.bar.setHidden(!copy.bar);
  if (copy.bar) {
    y -= 18 + 12;
    ob.bar.setFrame($.NSMakeRect(OB_LEFT, y, OB_WIDTH, 12));
    const { models } = S();
    ob.bar.setDoubleValue(models.total ? models.done / models.total : 0);
  }
  ob.scroll.setHidden(!copy.practice);
  if (copy.practice) {
    y -= 16 + 70;
    ob.scroll.setFrame($.NSMakeRect(OB_LEFT, y, OB_WIDTH, 70));
  }
  ob.check.setHidden(!copy.check);
  if (copy.check) {
    y -= 20 + 22;
    ob.check.setFrame($.NSMakeRect(OB_LEFT - 2, y, OB_WIDTH, 22));
  }
  ob.status.setHidden(!copy.status);
  ob.spinner.setHidden(!(copy.status && copy.busy));
  if (copy.status) {
    const indent = copy.busy ? 22 : 0;
    ob.status.setStringValue(copy.status);
    ob.status.setPreferredMaxLayoutWidth(OB_WIDTH - indent);
    const statusH = Math.ceil(ob.status.fittingSize.height);
    y -= 16 + statusH;
    ob.status.setFrame($.NSMakeRect(OB_LEFT + indent, y, OB_WIDTH - indent, statusH));
    // 綠字在淺色背景上太淡（systemGreen 對白底約 2.2:1）：淺色用深一點的綠
    const green = obDark() ? $.NSColor.systemGreenColor : $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.118, 0.498, 0.204, 1);
    ob.status.setTextColor(copy.ok ? green : copy.error ? $.NSColor.systemRedColor : $.NSColor.secondaryLabelColor);
    ob.spinner.setFrame($.NSMakeRect(OB_LEFT, y + statusH - 16 - 1, 16, 16));
    if (copy.busy) ob.spinner.startAnimation($());
  }
  if (!(copy.status && copy.busy)) ob.spinner.stopAnimation($());
  ob.steps.setHidden(!copy.step);
  if (copy.step) {
    ob.steps.setStringValue(t(`第 ${copy.step} 步，共 ${OB_STEPS} 步`, `Step ${copy.step} of ${OB_STEPS}`));
    ob.steps.setFrame($.NSMakeRect(OB_LEFT, 27, 200, 18));
  }
  const place = (button, title, right) => {
    button.setHidden(!title);
    if (!title) return right;
    button.setTitle(title);
    const w = Math.max(96, Math.ceil(button.fittingSize.width) + 16);
    button.setFrame($.NSMakeRect(right - w, 20, w, 32));
    return right - w - 8;
  };
  const next = place(ob.primary, copy.primary, OB_LEFT + OB_WIDTH);
  place(ob.secondary, copy.secondary, next);
  ob.primary.setEnabled(obStep !== 'try' || obTried());
}

// ── 換頁 ──
// 已經好了的那一頁跳過：權限給過、模型下載好、AI 整理已經有 key
function obSkippable(step) {
  const { models, settings } = S();
  if (step === 'mic') return micStatus() === 3;
  if (step === 'ax') return axTrusted();
  if (step === 'model') return models.state === 'done';
  if (step === 'ai') return !!(settings.ai.enabled && settings.ai.ready);
  return false;
}

function obGo(step) {
  if (obStep === 'try' && step !== 'try') setTryHere(false);
  if (obStep === 'mic' && step !== 'mic') stopMicHelper();
  obStep = step;
  if (step === 'model' && S().models.state !== 'done') runModels();
  if (step === 'try') {
    setTryHere(true);
    if (!S().running) runModels(() => { if (!S().running) startListener(); });
  }
  obRender();
  if (step === 'try') {
    $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
    obWindow.makeKeyAndOrderFront($());
    obWindow.makeFirstResponder(ob.practice);
  }
}

function obNext() {
  let i = OB_ORDER.indexOf(obStep) + 1;
  while (i < OB_ORDER.length - 1 && obSkippable(OB_ORDER[i])) i += 1;
  obGo(OB_ORDER[i]);
}

// 跳出麥克風詢問：帶起收音小幫手（下載版帶著編好的；install.sh 裝的編過才有），它一開麥克風系統就會問；
// 都沒有就帶起常駐程式（它會編小幫手、開麥克風）
function obAskMic() {
  if (micStatus() === 2) { openPrivacyPane('Privacy_Microphone'); return; }
  obMicAsked = true;
  const helper = [`${BUILD.repo}/bin/mic-capture`, statePath('bin/mic-capture')].find((path) => fm().isExecutableFileAtPath(path));
  if (!helper) { if (!S().running) startListener(); obRender(); return; }
  stopMicHelper();
  const m = $.NSTask.alloc.init;
  m.setLaunchPath(helper);
  m.setStandardOutput($.NSFileHandle.fileHandleWithNullDevice);
  m.setStandardError($.NSFileHandle.fileHandleWithNullDevice);
  try { m.launch; obMicTask = m; } catch (err) { uiLog(`麥克風詢問開不起來：${err}`); }
  obRender();
}

// 輔助使用：第一次讓系統跳詢問（也會把 JarvisVoice 加進清單），之後按就直接打開那一頁
function obAskAx() {
  if (!obAxAsked) $.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $('AXTrustedCheckOptionPrompt')));
  else openPrivacyPane('Privacy_Accessibility');
  obAxAsked = true;
  obRender();
}

function obPrimary() {
  switch (obStep) {
    case 'welcome': runModels(); obNext(); break;
    case 'mic': obAskMic(); break;
    case 'ax': obAskAx(); break;
    case 'model': if (S().models.state === 'error') { runModels(); obRender(); } else obNext(); break;
    case 'ai': obGo('done'); break;
    case 'done': obFinish(); break;
    default: obNext();
  }
}

function obFinish() {
  if (BUILD.bundled) setLoginItem(Number(ob.check.state) === 1);
  if (fm().fileExistsAtPath(statePath('onboarding'))) fm().removeItemAtPathError(statePath('onboarding'), null);
  fm().createFileAtPathContentsAttributes(statePath('onboarded'), $(), $());
  obFinished = true;
  obWindow.close;
}

// 每 0.5 秒：權限給了、模型好了就往下；試講那一頁更新狀態
function obTick() {
  if (!obWindow || !obWindow.isVisible) return;
  if (obStep === 'mic') {
    const status = micStatus();
    if (status === 3) obNext();
    else if (status === 2 && obMicTask) { stopMicHelper(); obRender(); }
  } else if (obStep === 'ax') {
    if (axTrusted()) obNext();
  } else if (obStep === 'try') {
    const text = obTryText();
    if (ObjC.unwrap(ob.status.stringValue) !== text || ob.primary.isEnabled !== obTried()) obRender();
  }
}

// ui.js 的模型下載有進度、結果時叫這裡
function onboardingModels() {
  if (!obWindow) return;
  if (obStep === 'model') {
    if (S().models.state === 'done') obNext();
    else obRender();
  } else if (obStep === 'try') obRender();
}

// 關掉視窗（按完成或紅色按鈕）：收掉試講與麥克風詢問，常駐程式還沒起來就帶起來
function obClosed() {
  if (obTimer) { obTimer.invalidate; obTimer = null; }
  closeOnboardingTasks();
  obStep = '';
  const { view, running, quitting } = S();
  if (view.state === 'setup') setUiState('starting');
  if (!running && !quitting) startWithModels();
}

ObjC.registerSubclass({
  name: 'JarvisVoiceOnboarding',
  methods: {
    'obPrimary:': { types: ['void', ['id']], implementation() { obPrimary(); } },
    'obSecondary:': { types: ['void', ['id']], implementation() { if (obStep === 'ai') { setUpKey(); obGo('done'); } else obNext(); } },
    'obTick:': { types: ['void', ['id']], implementation() { obTick(); } },
    'windowWillClose:': { types: ['void', ['id']], implementation() { obClosed(); } },
    // 試講那一頁：視窗回到最前面時游標一定在試講框（中途點到別的 app 再回來也是）
    'windowDidBecomeKey:': { types: ['void', ['id']], implementation() { if (obStep === 'try') obWindow.makeFirstResponder(ob.practice); } },
  },
});
const obController = $.JarvisVoiceOnboarding.alloc.init;

function openOnboarding() {
  ensureEditMenu(); // 試講時常駐程式用 Cmd+V 貼進來：選單列 app 要有「編輯」選單才收得到
  if (!fm().fileExistsAtPath(statePath('config.json'))) {
    $('{\n  "engine": "local"\n}\n').writeToFileAtomicallyEncodingError(statePath('config.json'), true, $.NSUTF8StringEncoding, null);
  }
  if (!fm().fileExistsAtPath(statePath('onboarded'))) fm().createFileAtPathContentsAttributes(statePath('onboarding'), $(), $());
  if (!obWindow) obBuild();
  obFinished = false;
  obMicAsked = false;
  obAxAsked = false;
  ob.practice.setString('');
  obGo('welcome');
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
  obWindow.makeKeyAndOrderFront($());
  if (!obTimer) obTimer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.5, obController, 'obTick:', $(), true);
}

// 測試用：把指定的幾頁畫成 PNG（不顯示視窗、不帶起任何程式、不要權限）。
// pages：[{ step, file, appearance, state（蓋過 uiState() 的）, micAsked, axAsked, practice（試講框裡的字）}]
function snapshotOnboarding(pages) {
  if (!obWindow) obBuild();
  return pages.map(({ step, file, appearance = 'NSAppearanceNameAqua', state = {}, micAsked = false, axAsked = false, practice = '' }) => {
    obWindow.setAppearance($.NSAppearance.appearanceNamed(appearance));
    obTestState = state;
    obMicAsked = micAsked;
    obAxAsked = axAsked;
    ob.practice.setString(practice);
    obStep = step;
    obRender();
    const frame = obWindow.contentView.superview;
    frame.layoutSubtreeIfNeeded;
    const rep = frame.bitmapImageRepForCachingDisplayInRect(frame.bounds);
    frame.cacheDisplayInRectToBitmapImageRep(frame.bounds, rep);
    rep.representationUsingTypeProperties(4, $()).writeToFileAtomically(file, true); // 4：PNG
    return file;
  });
}
