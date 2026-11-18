#!/usr/bin/env node
// 選單「設定自己的 key…」做的事（app/ui.js 帶起來，做完就結束）。終端機也可以直接跑：
//   node ~/jarvis-voice/bin/set-key.mjs set deepseek          貼上 key（畫面不顯示），先實際測一次，通了才存
//   node ~/jarvis-voice/bin/set-key.mjs set openai --engine   OpenAI：轉寫也改用 OpenAI（沒加就維持原本的轉寫，例如本機辨識）
//   node ~/jarvis-voice/bin/set-key.mjs clear deepseek        清除選單存的 key
// 哪一家：openai（轉寫與 AI 整理共用）、deepseek、claude、jev（TypeSafe Jev：自動找輸入框與語音指令的判斷，選用）。
// key 從 stdin 讀，不放在參數裡（參數 ps 看得到）；存在 macOS 鑰匙圈（bin/own-keys.mjs），不寫進設定檔。
// 測通了才存，並順手切過去：DeepSeek、Claude 把 AI 整理切到那家；OpenAI 的 AI 整理只在目前不能用時切（--ai 一定切），
// 轉寫只在 --engine（使用者勾了「轉寫也改用 OpenAI」）時切，不動本機辨識的預設；Jev 有 key 就會用，不用切。
// 常駐程式看到設定檔與 own-keys.json 改了會自己換。
// stdout 每行一個 JSON：{ type: 'key', state: 'testing' | 'saved' | 'cleared' | 'error', provider, message, ... }。

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryCleanup, tryDecider } from './checks.mjs';
import { STATE_DIR, aiAvailable, aiKey, loadConfig } from './config.mjs';
import { updateConfigFile } from './login.mjs';
import { createDecider } from './decide.mjs';
import { PROVIDER_NAMES } from './editor.mjs';
import { OWN_KEY_NAMES, OWN_KEY_PROVIDERS, cleanKey, ownKeyStore } from './own-keys.mjs';

const emit = (event) => process.stdout.write(`${JSON.stringify({ type: 'key', ...event })}\n`);
const zh = /^zh/i.test(process.env.VOICE_DICTATION_LANG || process.env.LANG || '');
const t = (zhText, enText) => (zh ? zhText : enText);
const ENGINE_NAMES = { local: t('本機辨識', 'on-device'), openai: 'OpenAI', account: t('JarvisVoice 帳號', 'JarvisVoice account'), parallelsandbox: t('平行沙盒', 'ParallelSandbox') };

// 實際打一次：OpenAI、DeepSeek、Claude 跑一段 AI 整理，Jev 跑一題第三層決策（都跟 ai-check 同一套）。回 { ms }，不通丟錯
export async function testKey(provider, key, config) {
  if (provider === 'jev') return tryDecider(createDecider(() => ({ jevKey: key, jevModel: config.jev.model, ai: null })));
  return tryCleanup({ provider, model: config.ai.models[provider] || '', apiKey: key });
}

// 測試沒通過的原因，講成使用者看得懂的話
export function failureReason(err, provider) {
  const name = OWN_KEY_NAMES[provider];
  const message = String(err?.message ?? err);
  const status = Number(message.match(/HTTP (\d{3})/)?.[1] ?? 0);
  if (status === 401 || status === 403) return t(`${name} 說這把 key 不對或沒有權限（HTTP ${status}）：確認整把 key 都有複製到再貼一次`, `${name} says this key is wrong or not allowed (HTTP ${status}): make sure you copied the whole key and paste it again`);
  if (status === 402) return t(`${name} 的帳戶餘額不足（HTTP 402）：先到 ${name} 儲值再試`, `Your ${name} account is out of balance (HTTP 402): top up at ${name} and try again`);
  if (status === 429) return t(`${name} 說超過用量或額度（HTTP 429）：確認帳戶有額度，或稍後再試`, `${name} says you're over your quota or rate limit (HTTP 429): check your account's credit, or try again later`);
  if (err?.name === 'TimeoutError' || /timeout|aborted/i.test(message)) return t(`${name} 太久沒回應：確認網路後再試一次`, `${name} took too long to respond: check your connection and try again`);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/.test(`${message} ${err?.cause?.code ?? ''}`)) return t(`連不到 ${name}：確認網路後再試一次`, `Can't reach ${name}: check your connection and try again`);
  return t(`測試沒通過：${message}`, `The test failed: ${message}`);
}

// 測通了：把要用這把 key 的設定切過去。config 是設定檔的內容（不是 loadConfig 補過預設的）；aiWorks：AI 整理現在能不能用
export function useOwnKey(config, provider, { engine = false, ai = false, aiWorks = true } = {}) {
  if (provider === 'openai' && engine) config.engine = 'openai';
  const toAi = provider === 'deepseek' || provider === 'claude'
    || (provider === 'openai' && (ai || (!aiWorks && config.ai?.enabled !== false)));
  if (toAi) config.ai = { ...config.ai, enabled: true, provider };
  return config;
}

// 清除後這家沒有別的 key 了：轉寫還是 OpenAI 的換回本機辨識（不然一講話就出錯）；AI 整理留著，選單會寫「（沒有 key）」
export function afterClear(config, provider, { stillHasKey }) {
  if (provider === 'openai' && !stillHasKey && config.engine === 'openai') config.engine = 'local';
  return config;
}

// 設定檔壞了（JSON 讀不懂）不蓋掉：key 照樣存，只是不切換，訊息說一聲
function tryUpdateConfig(change) {
  try {
    updateConfigFile(change);
    return '';
  } catch (err) {
    return t(`（設定檔讀不懂，沒有幫你切換：${err.message}）`, ` (couldn't read your config file, so nothing was switched: ${err.message})`);
  }
}

const hasKey = (config, provider) => (provider === 'jev' ? !!config.jev.apiKey : provider === 'openai' ? !!config.openai.apiKey : !!aiKey(config, provider));

// 存好之後現在用的是什麼（給選單的對話框）
function savedMessage(provider, config, ms) {
  const name = OWN_KEY_NAMES[provider];
  const parts = [];
  if (provider === 'openai') {
    parts.push(config.engine === 'openai'
      ? t('轉寫用 OpenAI', 'transcription uses OpenAI')
      : t(`轉寫維持${ENGINE_NAMES[config.engine]}（要換從選單「轉寫」選 OpenAI）`, `transcription stays ${ENGINE_NAMES[config.engine]} (switch under "Transcription" in the menu)`));
  }
  if (provider === 'jev') {
    parts.push(config.autoFocus || config.commands
      ? t('自動找輸入框與語音指令改由 Jev 判斷', 'auto-focus and voice commands are now decided by Jev')
      : t('自動找輸入框與語音指令目前都關著，從選單打開就會用 Jev 判斷', 'auto-focus and voice commands are both off; turn them on in the menu to use Jev'));
  } else if (config.ai.enabled && config.ai.provider === provider) {
    parts.push(t(`AI 整理用 ${name}`, `AI cleanup uses ${name}`));
  } else if (config.ai.enabled) {
    parts.push(t(`AI 整理維持 ${PROVIDER_NAMES[config.ai.provider]}（要換從選單「AI 整理」選 ${name}）`, `AI cleanup stays on ${PROVIDER_NAMES[config.ai.provider]} (switch under "AI cleanup" in the menu)`));
  } else {
    parts.push(t(`AI 整理關著（要用從選單「AI 整理」選 ${name}）`, `AI cleanup is off (choose ${name} under "AI cleanup" in the menu to use it)`));
  }
  return t(`${parts.join('；')}。key 存在 macOS 鑰匙圈，不在設定檔裡（測試 ${ms} ms）。`,
    `${parts.join('; ')}. The key is stored in the macOS Keychain, not in the config file (test took ${ms} ms).`).replace(/^./, (c) => c.toUpperCase());
}

// key 從 stdin 讀：選單從管子送進來；終端機請人貼上，不顯示
async function readKey() {
  const input = process.stdin;
  if (!input.isTTY) {
    const chunks = [];
    for await (const chunk of input) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  process.stderr.write(t('貼上 key 後按 Enter（畫面不會顯示）：', 'Paste the key and press Enter (it will not be shown): '));
  input.setRawMode(true);
  input.resume();
  let text = '';
  try {
    return await new Promise((done, fail) => {
      input.on('data', (data) => {
        for (const ch of data.toString('utf8')) {
          if (ch === '\r' || ch === '\n') { done(text); return; }
          if (ch === '\u0003') { fail(new Error(t('取消', 'Cancelled'))); return; }
          if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
          else text += ch;
        }
      });
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    process.stderr.write('\n');
  }
}

async function main() {
  const [action, provider, ...flags] = process.argv.slice(2);
  if (!['set', 'clear'].includes(action) || !OWN_KEY_PROVIDERS.includes(provider)) {
    throw new Error(t(`用法：set-key.mjs set|clear ${OWN_KEY_PROVIDERS.join('|')} [--engine] [--ai]`, `Usage: set-key.mjs set|clear ${OWN_KEY_PROVIDERS.join('|')} [--engine] [--ai]`));
  }
  const store = ownKeyStore(STATE_DIR);
  const name = OWN_KEY_NAMES[provider];
  if (action === 'clear') {
    store.clear(provider);
    const stillHasKey = hasKey(loadConfig().config, provider);
    const broken = tryUpdateConfig((c) => afterClear(c, provider, { stillHasKey }));
    const { config } = loadConfig();
    const rest = stillHasKey
      ? t('設定檔或環境變數裡還有一把，會改用那把', 'there is still a key in your config file or environment, which will be used instead')
      : provider === 'openai' && config.engine === 'local' ? t('轉寫換回本機辨識', 'transcription is back to on-device') : '';
    emit({ state: 'cleared', provider, message: `${t(`已清除 ${name} 的 key${rest ? `：${rest}` : ''}`, `Removed your ${name} key${rest ? `; ${rest}` : ''}`)}${broken}` });
    return;
  }
  const key = cleanKey(await readKey());
  const { config: before } = loadConfig();
  emit({ state: 'testing', provider, message: t(`測試 ${name} 的 key…`, `Testing your ${name} key…`) });
  let result;
  try {
    result = await testKey(provider, key, before);
  } catch (err) {
    emit({ state: 'error', provider, code: 'test_failed', message: failureReason(err, provider) });
    process.exitCode = 1;
    return;
  }
  store.write(provider, key);
  const aiWorks = before.ai.enabled && aiAvailable(before, before.ai.provider);
  const broken = tryUpdateConfig((c) => useOwnKey(c, provider, { engine: flags.includes('--engine'), ai: flags.includes('--ai'), aiWorks }));
  const { config } = loadConfig();
  emit({
    state: 'saved', provider, ms: result.ms, engine: config.engine, ai: { enabled: config.ai.enabled, provider: config.ai.provider },
    message: `${savedMessage(provider, config, result.ms)}${broken}`,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    emit({ state: 'error', code: 'failed', message: err.message });
    process.exitCode = 1;
  });
}
