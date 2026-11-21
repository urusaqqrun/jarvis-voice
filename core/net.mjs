// 連線層的錯翻成看得懂的話：fetch 還沒拿到回應就失敗時，Node 只寫「fetch failed」，原因（沒網路、被切斷、逾時）藏在 err.cause。
// 11/17、11/20、11/21 沒網路時選單只寫「出錯：fetch failed」，看不出是網路斷了。
// networkError(err, name) → 說明（name 是連的是誰：OpenAI、DeepSeek…，沒給就用錯誤裡的主機名）；不是連線層的錯回 ''。

const NO_NETWORK = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'EADDRNOTAVAIL']);
const TIMED_OUT = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const CUT_OFF = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

export function networkError(err, name = '') {
  if (err?.name === 'TimeoutError') return `等 ${name || '伺服器'} 回應逾時（網路很慢或斷了）`;
  if (!(err instanceof TypeError) || !/fetch failed|failed to fetch|networkerror|load failed/i.test(err.message)) return '';
  // 連 IPv4、IPv6 都失敗時 cause 是 AggregateError，原因在 errors 裡
  const cause = err.cause?.errors?.[0] ?? err.cause ?? {};
  const code = cause.code ?? err.cause?.code ?? '';
  const who = name || cause.hostname || '伺服器';
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false; // 網頁版沒有 cause，看瀏覽器說有沒有網路
  if (NO_NETWORK.has(code) || offline) return `沒網路，連不上 ${who}${code ? `（${code}）` : ''}`;
  if (TIMED_OUT.has(code)) return `連 ${who} 逾時，網路不穩或斷了（${code}）`;
  if (CUT_OFF.has(code)) return `跟 ${who} 的連線被切斷，網路不穩（${code}）`;
  if (code === 'ECONNREFUSED') return `${who} 拒絕連線（ECONNREFUSED）`;
  if (/CERT|SSL|TLS|SIGNATURE/.test(code)) return `${who} 的憑證驗證不過，可能是公司網路或代理擋住（${code}）`;
  return `連不上 ${who}（${code || cause.message || err.message}）`;
}
