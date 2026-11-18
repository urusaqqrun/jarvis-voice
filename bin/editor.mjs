// Mac 小程式的 AI 整理：規則和解析在核心（core/editor.mjs），這裡接「自己的 key」（core/providers.mjs），
// 或登入 JarvisVoice 帳號時的 JarvisVoice 伺服器（bin/account.mjs，用帳號點數）。
// 測試可以用環境變數把各家的網址換成本機假伺服器。

import { editSegment as coreEditSegment } from '../core/editor.mjs';
import { DEFAULT_MODELS as CORE_MODELS, PROVIDERS as CORE_PROVIDERS, PROVIDER_NAMES as CORE_NAMES, ownKeyService } from '../core/providers.mjs';
import { accountSession } from './account.mjs';

export { MODES, SCHEMA, buildPrompt, parseResult } from '../core/editor.mjs';
export const PROVIDERS = [...CORE_PROVIDERS, 'account'];
export const DEFAULT_MODELS = { ...CORE_MODELS, account: 'auto' };
const zh = /^zh/i.test(process.env.VOICE_DICTATION_LANG || process.env.LANG || '');
export const PROVIDER_NAMES = { ...CORE_NAMES, account: zh ? 'JarvisVoice 帳號' : 'JarvisVoice account' };

const envUrls = () => Object.fromEntries(Object.entries({
  openai: process.env.VOICE_DICTATION_OPENAI_CHAT_URL,
  deepseek: process.env.VOICE_DICTATION_DEEPSEEK_URL,
  claude: process.env.VOICE_DICTATION_ANTHROPIC_URL,
  jev: process.env.VOICE_DICTATION_JEV_URL,
}).filter(([, v]) => v));

// AI 的服務：{ model, complete, jev }。provider 是 account 時 complete 打 JarvisVoice 伺服器（accountUrl），不雙發（每一份都扣點數）；
// Jev 照樣用自己的 key（有的話）
export function service({ provider = 'openai', model, apiKey, timeoutMs, jevKey, jevModel, hedge, accountUrl } = {}) {
  if (provider === 'account') {
    const own = ownKeyService({ jevKey, jevModel, urls: envUrls() });
    const session = accountSession(accountUrl);
    return {
      model: 'JarvisVoice',
      complete: ({ system, user, timeoutMs: t = timeoutMs, signal }) => session.complete({ system, user, signal, timeoutMs: t }),
      jev: own.jev,
    };
  }
  return ownKeyService({ provider, model, apiKey, timeoutMs, jevKey, jevModel, hedge, urls: envUrls() });
}

function check(provider, apiKey, what) {
  if (!PROVIDERS.includes(provider)) throw new Error(`ai.provider 只能是 ${PROVIDERS.join('、')}`);
  if (!apiKey && provider !== 'account') throw new Error(`${what}沒有 ${PROVIDER_NAMES[provider]} API key`);
}

// 通用：照 system／user 問一次，回模型吐的字（要 JSON 的話自己 parse）
export async function ask({ provider = 'openai', model, apiKey, timeoutMs = 6000, system, user, schema = null, accountUrl }) {
  check(provider, apiKey, 'AI ');
  return service({ provider, model, apiKey, timeoutMs, accountUrl }).complete({ system, user, schema });
}

// 回傳 { mode, text, ms, model }；失敗丟錯，呼叫端改貼原稿。hedge：同時送幾份、誰先回用誰；signal：取消（提早整理作廢時）
export async function editSegment({ provider = 'openai', model, apiKey, timeoutMs = 6000, hedge = 1, signal, accountUrl, ...input }) {
  check(provider, apiKey, 'AI 編輯');
  const svc = service({ provider, model, apiKey, timeoutMs, hedge, accountUrl });
  const complete = signal ? (args) => svc.complete({ ...args, signal }) : svc.complete;
  return { ...(await coreEditSegment({ complete, ...input })), model: svc.model };
}
