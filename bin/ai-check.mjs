#!/usr/bin/env node
// 檢查 AI 整理和第三層決策設定好了沒：照設定檔實際打一次，印出用哪家、多快、整理結果。不印 key。
// 用法：node ~/jarvis-voice/bin/ai-check.mjs   （有問題時結束碼是 1）

import { CLEANUP_SAMPLE, COMMAND_SAMPLE, tryCleanup, tryDecider } from './checks.mjs';
import { aiAvailable, aiKey, loadConfig } from './config.mjs';
import { createDecider } from './decide.mjs';
import { DEFAULT_MODELS, PROVIDER_NAMES } from './editor.mjs';

const { config, error } = loadConfig();
let ok = true;
const fail = (message) => { console.log(message); ok = false; };

if (error) fail(`設定檔有問題：${error}`);
const provider = config.ai.provider;
const model = config.ai.models[provider] || DEFAULT_MODELS[provider];
console.log(`AI 整理：${config.ai.enabled ? '開' : '關（從選單「AI 整理」選一家，或設定檔 ai.enabled 改成 true）'}，用 ${PROVIDER_NAMES[provider]}（${model}）`);

const key = aiKey(config);
const ready = aiAvailable(config, provider);
if (!ready && provider === 'account') {
  fail('還沒登入 JarvisVoice：從選單按「登入 JarvisVoice…」，或跑 node ~/jarvis-voice/bin/login.mjs');
} else if (!ready) {
  fail(`沒有 ${PROVIDER_NAMES[provider]} 的 key：從選單「設定自己的 key…」貼上，或設定檔 ai.keys.${provider}、ai.keyFiles.${provider}、ai.keyCommands.${provider} 擇一`);
} else {
  try {
    const r = await tryCleanup({ provider, model, apiKey: key, accountUrl: config.account.apiUrl, vocabulary: config.openai.keywords });
    console.log(`整理測試（${r.ms} ms）：「${CLEANUP_SAMPLE}」→「${r.text}」`);
  } catch (err) {
    fail(`整理測試失敗：${err.message}`);
  }
}

console.log(`自動找輸入框：${config.autoFocus ? '開' : '關'}；語音指令：${config.commands ? '開' : '關'}${config.commands && !config.ai.enabled ? '（要先開 AI 整理才會用到）' : ''}`);
if (config.autoFocus || config.commands) {
  const decider = createDecider(() => ({
    jevKey: config.jev.apiKey, jevModel: config.jev.model,
    ai: ready ? { provider, model: config.ai.models[provider] || '', apiKey: key, accountUrl: config.account.apiUrl } : null,
  }));
  if (!decider.available()) {
    fail('第三層沒有決策器：要有 Jev key（選單「設定自己的 key…」，或 jev.apiKey／apiKeyFile／apiKeyCommand），或 AI 整理那家的 key（或登入 JarvisVoice 帳號）');
  } else {
    try {
      const a = await tryDecider(decider);
      console.log(`第三層決策（${a.engine}，${a.ms} ms）：「${COMMAND_SAMPLE}」判成 ${a.choice === 'command' ? '指令' : a.choice === 'dictation' ? '要打的字' : '（沒回答）'}`);
      if (a.choice !== 'command') fail('判斷不對：這句應該是指令');
    } catch (err) {
      fail(`第三層決策失敗：${err.message}`);
    }
  }
}

console.log(ok ? '都正常。' : '有問題，照上面的說明改設定檔，存檔後幾秒內會套用，再跑一次這個檢查。');
process.exitCode = ok ? 0 : 1;
