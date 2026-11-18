// 選單列小程式「JarvisVoice」的外殼（JXA，由 app/build.sh 用 osacompile 包成 .app，不用 Xcode）。
// 只負責把 app/ui.js 讀進來執行：介面和常駐程式管理都在 ui.js，改它不用重包 app，
// 麥克風與「輔助使用」權限也就不用重給（重包會換簽名，系統當成新的 app）。
// BUILD 由 build.sh 在包的時候填進來：{ node, repo, state }。app/package.sh 打的下載版填 null，路徑照 .app 自己在哪裡算：
// Node 是 Contents/Resources/node、程式在 Contents/Resources/app、狀態資料夾 ~/.voice-dictation（bundled 表示是下載版）。
ObjC.import('Cocoa');

// 不能叫 BUILD：最上層的 const 會蓋過 globalThis.BUILD，ui.js 讀到的就是這個（下載版是 null）
const BAKED = __BUILD__;

function bundledBuild() {
  const res = ObjC.unwrap($.NSBundle.mainBundle.resourcePath);
  const state = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('VOICE_DICTATION_STATE_DIR')) // 測試用，跟 bin/ 的程式同一個變數
    || `${ObjC.unwrap($.NSHomeDirectory())}/.voice-dictation`;
  return { node: `${res}/node`, repo: `${res}/app`, state, bundled: true };
}

function run() {
  globalThis.BUILD = BAKED ?? bundledBuild();
  const path = `${globalThis.BUILD.repo}/app/ui.js`;
  const code = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  try {
    if (!code || code.isNil()) throw new Error(`找不到 ${path}`);
    (0, eval)(ObjC.unwrap(code)); // 全域執行，ui.js 的 function 宣告都變成全域
    startUI();
  } catch (err) {
    // 介面檔壞了也要讓人知道：選單列直接寫出來，點開看原因
    const item = $.NSStatusBar.systemStatusBar.statusItemWithLength(-1);
    item.button.setTitle('JarvisVoice（介面載入失敗）');
    const menu = $.NSMenu.alloc.init;
    menu.addItem($.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(`介面載入失敗：${err}`, null, ''));
    item.setMenu(menu);
    globalThis.failedItem = item;
  }
}
