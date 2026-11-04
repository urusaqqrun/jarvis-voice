// JarvisVoice 核心的型別（給 TypeScript 專案用：CubeLV、平行沙盒）。

export type Complete = (req: { system: string; user: string; schema?: object | null; timeoutMs?: number; signal?: AbortSignal }) => Promise<string>;
export type Jev = (req: { state: unknown; questions: Record<string, Question> }) => Promise<Record<string, Answer>>;
export interface Question { type: 'choice' | 'noul' | 'score'; instructions: string; criteria?: unknown }
export interface Answer { type?: string; choice?: string; confidence?: number; noul?: number; probabilities?: Record<string, number> }

export interface Field { known?: boolean; editable?: boolean; role?: string; subrole?: string; label?: string; before?: string; after?: string; selected?: string; secure?: boolean }
export interface EditContext { app?: string; bundle?: string; window?: string; url?: string; screen?: string; field?: Field }
export type EditMode = 'insert' | 'replace_selection' | 'delete_last' | 'revert_last' | 'command';
export interface EditResult { mode: EditMode; text: string; goal?: string; app?: string; message?: string; /** 模型把不只語氣詞的話整理成空的，text 改回原稿 */ keptRaw?: boolean; ms: number }

export const MODES: EditMode[];
export const SCHEMA: object;
export function buildPrompt(input: { transcript: string; context?: EditContext; style?: string; vocabulary?: string[]; commands?: boolean }): { system: string; user: string };
export function parseResult(raw: string, opts?: { commands?: boolean }): Omit<EditResult, 'ms'> | null;
export function editSegment(input: { complete: Complete; transcript: string; context?: EditContext; style?: string; vocabulary?: string[]; commands?: boolean }): Promise<EditResult>;

/** outbound：一按送出就給別人的框（聊天室、留言、回信），游標不在框裡時不自動挑（App 標） */
export interface ScreenElement { handle: number; role: string; subrole?: string; label: string; value?: string; x: number; y: number; w: number; h: number; focused?: boolean; ocr?: boolean; outbound?: boolean }
export interface Frame { x?: number; y?: number; w?: number; h?: number; title?: string }
/** 看畫面的接頭：游標在輸入框時判斷是不是指令（judgeInField）用 */
export interface ScreenAdapter {
  elements(opts: { limit?: number; ocr?: 'never' | 'auto' | 'always' }): Promise<{ window: Frame; elements: ScreenElement[]; source?: string }>;
}
export interface Decider {
  available(): boolean;
  engine(): string;
  decide(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>>;
  canEscalate(): boolean;
  escalate(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>>;
}
export function createDecider(service: () => { jev?: Jev | null; complete?: Complete | null }): Decider;
export function intentQuestion(): Question;
export function inFieldIntentQuestion(): Question;
export function referenceQuestion(items: ScreenElement[], win?: Frame): Question;
export function fieldQuestions(candidates: ScreenElement[], win?: Frame): Record<string, Question>;
export function describeElement(e: ScreenElement, win?: Frame): string;
export function inFieldVerdict(answers: Record<string, Answer>, items: ScreenElement[]): { command: number; named: ScreenElement | null; isCommand: boolean };
export const IN_FIELD_SURE: number;
export const IN_FIELD_NAMED: number;

export interface CommandResult { ok: boolean; reason?: string; steps?: string[] }
export interface CommandStep { n: number; action: string; target: string }

// 操作代理（agent.mjs）：每一步看整頁結構，AI 從接頭宣告的工具挑一個做，做到畫面就是目標
export interface AgentTool { name: string; args: string; about: string }
export interface AgentCall { tool: string; args: Record<string, unknown>; why: string }
export interface AgentScreen {
  tools: AgentTool[];
  snapshot(): Promise<{ text: string; labels?: Record<string, string> }>;
  run(call: AgentCall): Promise<{ ok: boolean; note?: string }>;
  settle?(): Promise<void>;
  /** 這一步給人看的對象（小框用）；回 null 照 callTarget */
  describe?(call: AgentCall): string | null;
}
export interface AgentResult extends CommandResult { summary?: string }
export const MAX_AGENT_STEPS: number;
export const AGENT_TOOLS: Record<string, { args: string; about: string }>;
export function standardTools(names: string[]): AgentTool[];
export function agentPrompt(input: { goal: string; said?: string; context?: { app?: string }; screen: string; tools: AgentTool[]; done: string[] }): string;
export function parseCall(raw: string, names: Set<string>): AgentCall | null;
export function callTarget(call: AgentCall, labels?: Record<string, string>): string;
export function runAgent(input: { screen: AgentScreen; complete: Complete; goal: string; said?: string; context?: { app?: string }; log?: (m: string) => void;
  stopped?: () => boolean; onStep?: (step: CommandStep) => void; maxSteps?: number; timeoutMs?: number }): Promise<AgentResult>;

// 操作代理的畫面接頭共用的那一半（agentScreen.mjs）：App 只讀畫面（read → 節點）、動手（act）；結構樹怎麼寫、編號、小框寫什麼都在核心
export type AgentNode =
  | { depth: number; kind: 'group'; role: string; name?: string }
  | { depth: number; kind: 'heading' | 'text'; name: string }
  | { depth: number; kind: 'scroll'; name?: string; states?: string[]; off?: boolean | string; target: unknown }
  | { depth: number; kind: 'control'; role: string; name?: string; value?: string; states?: string[]; off?: boolean | string; target: unknown };
export interface AgentStepResult { ok: boolean; note?: string }
export interface AgentExtra {
  tools: AgentTool[];
  /** null＝不是它的工具，照標準工具做 */
  run(call: AgentCall): Promise<AgentStepResult | null>;
  describe?(call: AgentCall): string | null;
}
export interface CreatedAgentScreen extends AgentScreen {
  describe(call: AgentCall): string | null;
  /** 上一次 snapshot 這個編號對到的東西 */
  targetOf(ref: string): unknown;
}
export function createAgentScreen<T = unknown>(input: {
  tools: AgentTool[];
  read: () => AgentNode[] | Promise<AgentNode[]>;
  act: (call: AgentCall, target: T | null) => AgentStepResult | Promise<AgentStepResult>;
  header?: () => string | string[] | Promise<string | string[]>;
  extra?: AgentExtra;
  settle?: () => Promise<void>;
  maxRefs?: number;
  maxChars?: number;
  maxTextLines?: number;
}): CreatedAgentScreen;
export function writeTree(nodes: AgentNode[], opts?: { header?: string | string[]; maxRefs?: number; maxChars?: number; maxTextLines?: number }):
  { text: string; labels: Record<string, string>; refs: Map<string, unknown> };
export function describeCall(call: AgentCall, labels?: Record<string, string>): string;
export function keyName(key: unknown): string;
export function missingRef(ref: string): AgentStepResult;

export function rankTargets(input: { candidates: ScreenElement[]; window?: Frame; remembered?: { role: string; label?: string } | null }):
  { choice: ScreenElement | null; reason: string; sure: boolean; list: ScreenElement[] };
export function usable(c: ScreenElement): boolean;

export function extractEdited(value: string | null, before?: string, after?: string): string | null;
export function replacedChunks(a: string, b: string): { from: string; to: string }[];
export function createLearner(input: { read: (handle: number) => Promise<string | null>; log?: (m: string) => void;
  settings: () => { enabled: boolean; complete: Complete }; promote: (term: string, source: 'edit') => boolean }):
  { watch(w: { handle: number; inserted: string; before: string; after: string }): void; tick(): Promise<void> };

export const AUTO_HEADER: string;
export function splitVocabulary(text: string): { manualText: string; manual: string[]; auto: string[] };
export function plausibleTerm(term: string): boolean;
export interface VocabStore { loadState(): unknown; saveState(state: unknown): void; readVocab(): string; writeVocab(text: string): void }
export function createVocabAuto(input: { log?: (m: string) => void; store: VocabStore;
  settings: () => { enabled?: boolean; max?: number; maxAuto?: number; minSightings?: number; complete?: Complete | null } }): {
  promote(word: string, source: 'edit' | 'heard' | 'screen', now?: number): boolean;
  observe(terms: string[], now?: number): void;
  noteHits(text: string, now?: number): void;
  promoteHeard(text: string, now?: number): void;
  afterSegment(input: { screen?: string; text?: string }, now?: number): Promise<void>;
};

export interface AudioTurn { startMs: number; endMs: number }
export class AudioTurnDetector {
  readonly speaking: boolean;
  /** 有聲音了但還不到 180 ms，還不知道是開口還是雜音 */
  readonly starting: boolean;
  readonly currentStartMs: number | null;
  silenceMs: number;
  lastVoiced: boolean;
  /** 沒在講話時沒算成人聲的那幾批裡最大的音量與尖峰（呼叫端記 log 後自己歸零） */
  missLevel: number;
  missPeak: number;
  /** peakOverNoise：還沒開口時的尖峰門檻改成底噪的這麼多倍（不低於 0.055）；預設是底噪 × 15 */
  constructor(opts?: { peakOverNoise?: number });
  /** 現在的底噪與開口門檻（RMS、尖峰） */
  thresholds(): { noise: number; level: number; peak: number };
  lastVoiceEnd: number;
  shortBlips: number;
  push(samples: Int16Array, startMs: number): AudioTurn | null;
  finish(): AudioTurn | null;
}
export class TurnSplitter {
  /** tentativeMs：講話中停這麼久先報 tentative（預設 400，0 是不報） */
  constructor(opts?: { preRollBatches?: number; tentativeMs?: number; peakOverNoise?: number });
  readonly detector: AudioTurnDetector;
  readonly speaking: boolean;
  readonly currentStartMs: number | null;
  /** tentative：停了 tentativeMs，可以先送轉寫；resumed：之後又開口，先送的作廢 */
  push(samples: Int16Array, startMs: number): { audio: Uint8Array[]; turn: AudioTurn | null; tentative: boolean; resumed: boolean };
  finish(): { audio: Uint8Array[]; turn: AudioTurn | null; tentative: boolean; resumed: boolean };
}

/** 轉寫連線接頭：WebSocket 網址，或連線前要帶的 header 與開線後第一個送出的設定。 */
export type TranscriptionTarget = string | { url: string; headers?: Record<string, string>; sessionUpdate?: object };
export type TranscriptionConnect = () => Promise<TranscriptionTarget>;
export interface TranscriptItemUpdate { id: string; startMs: number; endMs?: number; text: string; final: boolean }
export type VoiceActivity = 'idle' | 'hearing' | 'recognizing';
export interface TranscriberOptions {
  connect: TranscriptionConnect;
  onItem?: (item: TranscriptItemUpdate) => void;
  onTranscript?: (transcript: string) => void;
  onFinal?: (text: string, item: { id: string; startMs?: number; endMs?: number }) => void;
  onPending?: () => void;
  onError?: (error: Error) => void;
  log?: (message: string) => void;
  describe?: () => string;
  startHint?: () => number | null;
  elapsed?: () => number;
  lazy?: boolean;
  maxReconnects?: number;
  retryBaseMs?: number;
  openTimeoutMs?: number;
  /** 只聽使用者的聲音：後端算聲紋、照這份擋（createRemoteVoiceprint().transcription） */
  voiceprint?: TranscriptionVoiceprint | null;
}
/** 後端每句回來的聲紋結果 */
export interface VoiceprintTurnEvent { type: 'voiceprint.turn'; commit_event_id: string; pass: boolean; score: number | null; seconds: number; embedding: number[] | null; ms?: number }
export interface TranscriptionVoiceprint {
  config(): VoiceprintGate | null;
  /** 後端回 voiceprint.ready（帶模型名稱）；回傳 true＝擋法變了，再送一次 */
  onReady?(info: { model?: string }): boolean;
  /** 每句的結果；回傳 true＝擋法變了，再送一次 */
  onTurn?(event: VoiceprintTurnEvent): boolean;
  /** 這個後端不會擋（舊版、沒裝模型）：照常轉寫，畫面別再顯示「正在建立聲紋」 */
  onUnsupported?(): void;
}
export interface Transcriber {
  append(bytes: Uint8Array): void;
  commit(turn: AudioTurn): number;
  flush(): void;
  pending(): number;
  lastSequence(): number;
  /** 擋法變了（重錄、開關）：連著的話馬上送新的設定給後端 */
  updateVoiceprint(): void;
  busy(): boolean;
  readonly failed: Error | null;
  transcript(): string;
  waitForOpen(): Promise<void>;
  waitFor(target?: number): Promise<void>;
  finish(): Promise<string>;
  /** 這句作廢：字不算進全文、不用等它回來 */
  discard(sequence: number): void;
  idle(state?: { active?: boolean; quietForMs?: number; speaking?: boolean }): void;
  close(): void;
}
export function createTranscriber(options: TranscriberOptions): Transcriber;
export interface SpeechTranscription {
  push(samples: Int16Array, at?: { startSample?: number; at?: number }): void;
  cut(): void;
  updateVoiceprint(): void;
  readonly speaking: boolean;
  readonly capturedUntilMs: number;
  readonly failed: Error | null;
  checkpoint(wait?: boolean): Promise<number>;
  finish(): Promise<string>;
  stopCapture(): void;
  close(): void;
}
export function createSpeechTranscription(options: Omit<TranscriberOptions, 'onPending' | 'startHint' | 'elapsed'> & {
  recordingStartedAt?: number;
  onActivity?: (activity: VoiceActivity) => void;
  /** 停 earlyTranscribeMs 就先 commit；又開口時 split＝切成兩句，resend＝作廢重送整句（多計費）。預設關 */
  earlyTranscribe?: false | 'split' | 'resend';
  earlyTranscribeMs?: number;
}): SpeechTranscription;
export function permanentError(message: string): Error & { permanent: true };
export function base64FromBytes(bytes: Uint8Array): string;
export const MAX_RECONNECTS: number;
export const AUDIO_GAP_MS: number;

export type PolishOutcome =
  | { kind: 'polished'; text: string }
  | { kind: 'empty' }
  | { kind: 'raw'; reason: 'unsupported' | 'timeout' | 'failed' };
export function polishTranscript(input: { transcript: string; complete: Complete; context?: EditContext; vocabulary?: string[]; timeoutMs?: number; log?: (message: string) => void }): Promise<PolishOutcome>;
/** 換回原文要的東西：錄音前輸入框的字、原稿、整理後的字（空字串＝只有語氣詞、沒寫）、寫進去的整段。 */
export interface PolishRevert { base: string; raw: string; text: string; written: string }
export interface DictationWrite { input: string; send: boolean; revert: PolishRevert | null; review: boolean; notice: '' | 'voicePolishFailed' }
export function mergeTranscript(base: string, transcript: string): string;
export function joinPolished(base: string, text: string): string;
export function changedWords(raw: string, text: string): boolean;
export function revertPolish(current: string, revert: PolishRevert, readBack?: string): string | null;
export function applyPolish(base: string, raw: string, outcome: PolishOutcome, action: 'send' | 'insert'): DictationWrite;
export const POLISH_TIMEOUT_MS: number;
export function isSpeech(text: string): boolean;
export function onlyFiller(text: string): boolean;

/** 截圖認出的一段字；位置單位各平台自訂（同一次辨識一致），原點在左上角。 */
export interface OcrItem { text: string; x: number; y: number; w: number; h: number }
export function readingOrder<T extends OcrItem>(items: T[] | null | undefined): T[];
export function ocrText(items: OcrItem[] | null | undefined, opts?: { maxChars?: number }): string;
export function joinScreen(sections: (string | null | undefined)[], opts?: { maxChars?: number }): string;
export function withSpacing(text: string): string;

export const PROVIDERS: string[];
export const DEFAULT_MODELS: Record<string, string>;
export const PROVIDER_NAMES: Record<string, string>;
export const DEFAULT_URLS: Record<string, string>;
export function ownKeyService(input: { provider?: string; model?: string; apiKey?: string; jevKey?: string; jevModel?: string; timeoutMs?: number; urls?: Record<string, string>; hedge?: number }):
  { model: string; complete: Complete | null; jev: Jev | null };
/** 同一個請求同時送 copies 份，誰先成功用誰、其他的取消；call 要吃 args.signal */
export function hedge<A extends { signal?: AbortSignal }, R>(call: (args: A) => Promise<R>, copies?: number): (args: A) => Promise<R>;
export const CORE_VERSION: string;

/** 聲紋過濾：聲紋（正規化過的 embedding）由呼叫端算，這裡判斷是不是使用者 */
export const VOICEPRINT_THRESHOLD: number;
export const VOICEPRINT_MIN_SECONDS: number;
export const VOICEPRINT_SHORT_THRESHOLD: number;
export const ENROLL_SECONDS: number;
export const REMOTE_VOICEPRINT_MODEL: string;
/** 給後端的擋法：參考聲紋與門檻（短於 minSeconds 用 shortThreshold） */
export interface VoiceprintGate { reference: number[]; threshold: number; shortThreshold: number; minSeconds: number }
export function passesGate(gate: VoiceprintGate | null, score: number | null | undefined, sec: number): boolean;
export interface VoiceprintSaved { model: string; at: number; enrolled: number[][]; recent: number[][]; pending: { v: number[]; sec: number }[]; session?: { at: number; score: number }[] }
/** 每句判斷完：畫面只拿來說略過了幾句（聲紋在背景學，不顯示建立中、還要講幾秒） */
export interface VoiceprintChange { enrolled: boolean; pass: boolean; verdict: VoiceprintVerdict['verdict']; score: number | null }
export function createRemoteVoiceprint(opts: {
  store: { load(): VoiceprintSaved | null; save(saved: VoiceprintSaved): void; clear(): void };
  onChange?: (change: VoiceprintChange) => void;
  threshold?: number; minSeconds?: number; shortThreshold?: number;
}): { enrolled(): boolean; reset(): void; transcription: TranscriptionVoiceprint };
export interface VoiceprintVerdict { pass: boolean; verdict: 'enrolling' | 'enrolled' | 'short' | 'mine' | 'other'; score: number | null; kept?: number }
export function createVoiceprint(opts?: { state?: { enrolled?: number[][]; recent?: number[][]; pending?: { v: number[]; sec: number }[]; session?: { at: number; score: number }[] }; threshold?: number; minSeconds?: number; shortThreshold?: number; now?: () => number }): {
  enrolled(): boolean;
  judge(v: ArrayLike<number>, sec: number, opts?: { dryRun?: boolean }): VoiceprintVerdict;
  /** 這一場的長句門檻（同一場放行的長句滿 3 句後跟著分數往上提） */
  threshold(): number;
  gate(): VoiceprintGate | null;
  reset(): void;
  state(): { enrolled: number[][]; recent: number[][]; pending: { v: number[]; sec: number }[]; session: { at: number; score: number }[] };
};
export function pickEnrollment<T extends { v: ArrayLike<number>; sec: number }>(items: T[]): T[];
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number;
export function normalize(v: ArrayLike<number>): number[];
export function meanVector(items: { v: ArrayLike<number>; sec?: number }[]): number[] | null;

// ---- 一段話講完之後怎麼處理（flow.mjs）----
export const NOT_IN_FIELD_SURE: number;
export interface InFieldJudgement { command: number; named: ScreenElement | null; isCommand: boolean; source?: string }
export function judgeInField(input: { raw: string; screen: ScreenAdapter; decider: Decider; field?: { label?: string; role?: string };
  context?: { app?: string; window?: string } }): Promise<InFieldJudgement>;
export type JudgedUtterance = (EditResult & { model?: string }) | { failed: string } | null;
export function judgeUtterance(input: { raw: string; inField: boolean; edit: (transcript: string) => Promise<EditResult>;
  judge?: Promise<InFieldJudgement | null> | null; intent?: Promise<number | null> | null; aborted?: () => boolean; log?: (m: string) => void }): Promise<JudgedUtterance>;
export type OutputPlan =
  | { kind: 'command'; result: EditResult }
  | { kind: 'delete_last' }
  | { kind: 'revert_last' }
  | { kind: 'filler' }
  | { kind: 'write'; text: string; mode: EditMode; ai: boolean; failed?: string; result?: EditResult | null }
  | { kind: 'navigate'; target: string; text: string };
/** navigate：App 要「打開／進到／去」開頭、AI 判成打字的短句改成 navigate（CubeLV：游標不在輸入框時）；不給照舊 */
export function planOutput(input: { raw: string; result: JudgedUtterance | undefined; navigate?: boolean }): OutputPlan;
/** 開頭是「打開／進到／去」的短句：要去的地方；不是就回 null */
export function navigationIntent(raw: string): { verb: string; target: string } | null;
export function isExplicitCommand(raw: string): boolean;
export function pickTarget(input: { candidates: ScreenElement[]; window?: Frame | null; remembered?: { role: string; label?: string; frame?: { y: number } } | null;
  transcript?: string; decider?: Decider | null; context?: { app?: string }; log?: (m: string) => void }): Promise<{ choice: ScreenElement; reason: string } | null>;

// ---- 一直收音時幾句合成一段（segment.mjs）----
export const SEGMENT_PAUSE_MS: number;
export const PASTE_AFTER_MS: number;
export const MAX_SEGMENT_CHARS: number;
export interface Segmenter<H = unknown, P = unknown> {
  add(text: string, heard?: H): void;
  check(): void;
  force(): void;
  drop(reason: string): void;
  has(): boolean;
  parts(): string[];
  /** 正在提早整理的那段原稿（沒有就是 null） */
  working(): string | null;
  raw(): string;
  clear(): void;
}
type Num = number | (() => number);
export function createSegmenter<H = unknown, P = unknown>(input: {
  pauseMs?: Num; pasteAfterMs?: Num; maxChars?: Num;
  state: () => { speaking: boolean; starting?: boolean; busy: boolean; lastVoiceAt: number };
  prepare?: ((raw: string, signal: AbortSignal) => Promise<P>) | null;
  onWorking?: (raw: string) => void;
  onSegment: (segment: { raw: string; heard?: H; prepared: Promise<P | null> | null; earlyPolish: boolean }) => void;
  log?: (m: string) => void; now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void;
}): Segmenter<H, P>;
export function heardText(parts?: string[], previews?: string[]): string;
/** 講話中小框寫什麼（Mac 小程式、CubeLV 同一個）；confirmedOnly：確認是使用者講的才跳（CubeLV 一直聽）；null＝不顯示 */
export function speechBubble(input: {
  heard?: string;
  live?: string;
  working?: string;
  speaking?: boolean;
  speaker?: '' | 'mine' | 'short';
  ignored?: string;
  lastMine?: boolean;
  confirmedOnly?: boolean;
}): { state: 'working' | 'hearing' | 'ignored'; text: string; speaker: '' | 'mine' | 'short' } | null;

// ---- 字先進輸入框：邊講邊打、準的字換掉預覽、整理好再換掉（draft.mjs）----
export interface Draft<W = unknown> {
  /** 框裡這份草稿現在的字 */
  text: string;
  /** 寫之前游標前的字（給 AI 當上下文） */
  before: string;
  where: W | null;
  /** 不再換了（送出了、自己改了、游標移走了） */
  gone: boolean;
  writtenAt: number;
}
export interface DraftRewrite<W = unknown> {
  /** 游標前面要正好是這些字（我們寫的） */
  expect: string;
  /** 留下 expect 的前幾個字 */
  same: number;
  /** 後面換成這些字 */
  text: string;
  where: W | null;
  why: 'preview' | 'sentence' | 'settle' | 'drop';
}
export type DraftRewriteResult<W = unknown> = { ok: true; before?: string; where?: W } | { ok: false; reason: string; before?: string };
export const LIVE_PAUSE_MS: number;
export interface DraftWriter<W = unknown> {
  /** 這句講到一半認到的字，框裡跟著改 */
  preview(turn: number, text: string): void;
  /** restart：這段前面的字不再算這段；dropped：這句不算（已經送出）；stale：等不到準的字、留在框裡的預覽，要併進這段 */
  add(sentence: string, turn?: number): Promise<{ written: boolean; restart: boolean; dropped?: boolean; stale?: string }>;
  /** 這句不算：把預覽拿掉 */
  drop(turn?: number): Promise<void>;
  close(): Draft<W> | null;
  /** 'ok' 換好了、'same' 字一樣不用換、'gone' 早就不再換，其他是對不上的原因 */
  settle(draft: Draft<W>, text: string): Promise<string>;
  forget(draft: Draft<W>): void;
  current(): Draft<W> | null;
  /** 框裡有這次講的字 */
  typing(): boolean;
  busy(): boolean;
}
export function createDraftWriter<W = unknown>(input: {
  rewrite: (request: DraftRewrite<W>) => Promise<DraftRewriteResult<W>>;
  commands?: () => boolean;
  log?: (m: string) => void;
  now?: () => number;
}): DraftWriter<W>;

// ---- 小框的階段（bubble.mjs）----
export type BubbleState = 'hearing' | 'ignored' | 'working' | 'pasted' | 'polished' | 'command' | 'done' | 'failed' | 'nofield' | 'noplace' | 'error' | 'hide';
export interface BubbleEvent { state: BubbleState; text?: string; detail?: string; speaker?: '' | 'mine' | 'short' }
export interface BubbleContent { title: string; body: string; tone: 'blue' | 'green' | 'orange' | 'red'; loud: boolean; busy: boolean; result: boolean; holdMs: number | null }
export const BUBBLE_HOLD_MS: Record<string, number>;
export const BUBBLE_MAX_CHARS: number;
export function bubbleContent(event: BubbleEvent, lang?: string): BubbleContent | null;
export function stepText(step: CommandStep, lang?: string): string;
export function clipHead(text: string, max?: number): string;
