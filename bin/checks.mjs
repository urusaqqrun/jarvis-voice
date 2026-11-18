// 實際打一次 AI 整理與第三層決策，看 key 和設定通不通：bin/ai-check.mjs（照設定檔檢查）與
// bin/set-key.mjs（選單「設定自己的 key…」存之前先測）共用。不印 key。

import { intentQuestion } from './decide.mjs';
import { editSegment } from './editor.mjs';

export const CLEANUP_SAMPLE = '嗯那個我們明天三點開會，不對，四點開會，然後記得帶那個筆電';
export const COMMAND_SAMPLE = '進到台積電的個股頁';

// AI 整理：回 { text, ms, model }；失敗丟錯（訊息帶 HTTP 狀態，例如 401 是 key 不對）
export function tryCleanup({ provider, model, apiKey, accountUrl, vocabulary = [], timeoutMs = 15_000 }) {
  return editSegment({
    provider, model, apiKey, accountUrl, timeoutMs, transcript: CLEANUP_SAMPLE,
    context: { app: 'Slack', field: { role: 'AXTextArea', label: '訊息' } }, vocabulary,
  });
}

// 第三層決策：「進到台積電的個股頁」應該判成指令。回 { choice（command／dictation／空的）, ms, engine（Jev／AI）}
export async function tryDecider(decider) {
  const started = Date.now();
  const answers = await decider.decide({ transcript: COMMAND_SAMPLE, app: '看盤', window: '自選股', field: '' }, { intent: intentQuestion() });
  return { choice: answers.intent?.choice ?? '', ms: Date.now() - started, engine: decider.engine() };
}
