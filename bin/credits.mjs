#!/usr/bin/env node
// 選單「購買點數（不用 key）…」做的事（app/ui.js 帶起來，做完就結束）。要先用 CubeLV 登入（選單會先帶去登入）。
//   node ~/jarvis-voice/bin/credits.mjs account         剩幾點、每分鐘扣幾點、可以買的點數包
//   node ~/jarvis-voice/bin/credits.mjs buy <package>   開 Stripe 付款頁，回網址（選單用瀏覽器打開）；付完點數自己加進帳號
// 點數、價格、付款都是 CubeLV 那一套（跟 CubeLV 網頁版買的同一種點數），這裡只是在 JarvisVoice 裡買。
// stdout 一行一個 JSON：{ type: 'credits', state: 'account', email, balance, creditsPerMinute, packages }
//   | { state: 'checkout', url } | { state: 'error', code, message }（code：not_logged_in、login_expired、unsupported 或空的）

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { cubelvSession } from './cubelv.mjs';

const emit = (event) => process.stdout.write(`${JSON.stringify({ type: 'credits', ...event })}\n`);

export async function runCredits(args, { apiUrl = loadConfig().config.cubelv.apiUrl } = {}) {
  const [command, packageId] = args;
  const session = cubelvSession(apiUrl);
  if (command === 'account') {
    const account = await session.account();
    return {
      state: 'account',
      email: account.email ?? '',
      balance: Number(account.balance ?? 0),
      creditsPerMinute: account.credits_per_minute ?? null,
      packages: (account.packages ?? []).map((p) => ({ id: p.package_id, credits: p.credits, priceUsd: p.price_usd })),
    };
  }
  if (command === 'buy' && packageId) return { state: 'checkout', url: await session.checkout(packageId) };
  throw new Error(`用法：credits.mjs account | buy <package>（收到：${args.join(' ')}）`);
}

// 直接執行才跑（從 symlink 叫也算）
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCredits(process.argv.slice(2)).then(emit, (err) => {
    emit({ state: 'error', code: err.code ?? '', message: err.message });
    process.exitCode = 1;
  });
}
