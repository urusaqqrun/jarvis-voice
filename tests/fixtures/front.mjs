// 測試共用：macOS 新開的視窗會不會跑到最前面不一定，要在前景的就用 AX 設成最前面，要在背景的就把原本的 app 叫回來，
// 等確定了再動作。
import { execFileSync } from 'node:child_process';

const lsappinfo = (...args) => execFileSync('/usr/bin/lsappinfo', args).toString();
const frontInfo = () => lsappinfo('info', '-only', 'pid', lsappinfo('front').trim());
export const frontPid = () => Number(frontInfo().match(/"pid"=(\d+)/)?.[1] ?? 0);
const startPid = Number(frontInfo().match(/"pid"=(\d+)/)?.[1] ?? 0);

export async function waitFront(check) {
  for (let i = 0; i < 30 && !check(frontPid()); i += 1) await new Promise((r) => setTimeout(r, 100));
  return check(frontPid());
}

export async function sendToBack(pid) {
  if (startPid) await bringToFront(startPid);
  return waitFront((p) => p !== pid);
}

export async function bringToFront(pid) {
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('ApplicationServices');
    ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
    ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
    $.AXUIElementSetAttributeValue($.AXUIElementCreateApplication(${pid}), $('AXFrontmost'), $.NSNumber.numberWithBool(true));`]);
  return waitFront((p) => p === pid);
}

// 新開的 app 過一兩秒前景會自己回到原本的 app：站穩了才開始
export async function holdFront(pid, stableMs = 2000) {
  for (let i = 0; i < 6; i += 1) {
    if (await bringToFront(pid)) {
      await new Promise((r) => setTimeout(r, stableMs));
      if (frontPid() === pid) return true;
    }
  }
  return false;
}

// 把原本在最前面的 app 叫回來。照 pid 叫：同一個 app 開了好幾個（例如好幾個 Claude）時，照 bundle id 會叫到別的
export function restoreFront() {
  if (startPid) bringToFront(startPid).catch(() => {});
}
