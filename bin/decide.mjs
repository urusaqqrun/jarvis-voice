// Mac 小程式的第三層決策：題目、門檻、決策器在核心（core/decide.mjs），這裡接「自己的 key」的 Jev 和 AI。

import { createDecider as coreCreateDecider } from '../core/decide.mjs';
import { service } from './editor.mjs';

export * from '../core/decide.mjs';

// settings()：{ jevKey, jevModel, ai }（ai 是 { provider, model, apiKey, timeoutMs, accountUrl }，AI 整理能用時才給；
// 沒有 Jev 時、或 Jev 拿不準時用。用 JarvisVoice 帳號時沒有 apiKey，complete 打 JarvisVoice 伺服器）
export function createDecider(settings) {
  return coreCreateDecider(() => {
    const s = settings();
    const svc = service({ ...(s.ai ?? {}), jevKey: s.jevKey, jevModel: s.jevModel });
    return { jev: svc.jev, complete: s.ai && (s.ai.apiKey || s.ai.provider === 'account') ? svc.complete : null };
  });
}
