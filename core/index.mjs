// JarvisVoice 核心：一份給 Mac 小程式、CubeLV、平行沙盒共用的語音輸入邏輯。
// 只放和平台無關的東西（不用 node: 模組、不碰檔案）：要看畫面、打模型、存東西，都由呼叫端傳接頭進來。
//   - 服務接頭：complete({ system, user, schema }) → 模型吐的字；jev({ state, questions }) → answers（可以沒有）
//   - 畫面接頭：elements({ limit, ocr })（游標在輸入框時判斷是不是指令）；操作代理的接頭由 createAgentScreen 組：App 給 read()（畫面讀成節點）、act()（動手）
//   - 存放接頭：loadState、saveState、readVocab、writeVocab
//   - 轉寫連線接頭：connect() → WebSocket 網址或 { url, headers, sessionUpdate }（OpenAI 直連、平行沙盒 control、CubeLV 後端）
// 架構說明：jarvis-voice/docs/ARCHITECTURE.md

export * from './editor.mjs';
export * from './decide.mjs';
export { runAgent, standardTools, agentPrompt, parseCall, callTarget, AGENT_TOOLS, MAX_AGENT_STEPS } from './agent.mjs';
export { createAgentScreen, writeTree, describeCall, keyName, missingRef } from './agentScreen.mjs';
export { usable, score as fieldScore, rankTargets } from './targeter.mjs';
export { extractEdited, replacedChunks, createLearner } from './learn.mjs';
export { AUTO_HEADER, splitVocabulary, plausibleTerm, score as vocabScore, createVocabAuto } from './vocab.mjs';
export { AudioTurnDetector, TurnSplitter } from './turns.mjs';
export { createTranscriber, createSpeechTranscription, permanentError, base64FromBytes, MAX_RECONNECTS, AUDIO_GAP_MS } from './transcription.mjs';
export { polishTranscript, mergeTranscript, joinPolished, changedWords, revertPolish, applyPolish, POLISH_TIMEOUT_MS } from './dictation.mjs';
export { isSpeech, onlyFiller, withSpacing } from './text.mjs';
export { readingOrder, ocrText, joinScreen } from './ocr.mjs';
export { PROVIDERS, DEFAULT_MODELS, PROVIDER_NAMES, DEFAULT_URLS, ownKeyService } from './providers.mjs';
export { hedge } from './hedge.mjs';
export { judgeUtterance, judgeInField, planOutput, pickTarget, navigationIntent, NOT_IN_FIELD_SURE } from './flow.mjs';
export { createSegmenter, heardText, speechBubble, SEGMENT_PAUSE_MS, PASTE_AFTER_MS, MAX_SEGMENT_CHARS } from './segment.mjs';
export { bubbleContent, stepText, clipHead, BUBBLE_HOLD_MS, BUBBLE_MAX_CHARS } from './bubble.mjs';
export { createVoiceprint, createRemoteVoiceprint, passesGate, pickEnrollment, cosine, normalize, meanVector, VOICEPRINT_THRESHOLD, VOICEPRINT_MIN_SECONDS, VOICEPRINT_SHORT_THRESHOLD, ENROLL_SECONDS, REMOTE_VOICEPRINT_MODEL } from './voiceprint.mjs';

export const CORE_VERSION = '1.0.0';
