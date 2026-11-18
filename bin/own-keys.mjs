// 自己的 key（選單「設定自己的 key…」存的）：OpenAI（轉寫與 AI 整理共用）、DeepSeek、Claude、TypeSafe Jev。
//   - macOS 存在鑰匙圈（服務「JarvisVoice key」、帳號是哪一家，鑰匙圈存取裡看得到「JarvisVoice OpenAI key」這幾筆），不寫進設定檔；
//     其他系統（或 VOICE_DICTATION_TOKEN_STORE=file）存在狀態資料夾裡只有自己讀得到的檔案（0600）。跟 JarvisVoice 帳號的 token 同一套（bin/account.mjs 的 tokenStore）。
//   - 狀態資料夾的 own-keys.json 只記「哪幾家存了 key、什麼時候存的」（不是秘密）：讀設定時只去鑰匙圈拿這幾家，
//     常駐程式看它改了就重讀設定（bin/config.mjs 的 configMtime）。
//   - 讀取順序（bin/config.mjs）：這裡存的最優先，再來才是設定檔的 apiKey／keys、apiKeyFile／keyFiles、keyCommands、環境變數。
//     選單存的是使用者最近一次親手貼、而且測過能用的 key；清除後就回到原本的設定方式，沒從選單存過 key 的人完全照舊。

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OWN_KEY_PROVIDERS = ['openai', 'deepseek', 'claude', 'jev'];
export const OWN_KEY_NAMES = { openai: 'OpenAI', deepseek: 'DeepSeek', claude: 'Claude', jev: 'TypeSafe Jev' };
export const OWN_KEYS_FILE = 'own-keys.json';
const SECRET_FILE = 'own-keys-secret.json';
const KEYCHAIN_SERVICE = 'JarvisVoice key';

const zh = () => /^zh/i.test(process.env.VOICE_DICTATION_LANG || process.env.LANG || '');
const t = (zhText, enText) => (zh() ? zhText : enText);

// 貼上的字整理成 key：去掉前後空白、引號，以及 .env 的「OPENAI_API_KEY=」；中間有空白或換行就不是一把 key
export function cleanKey(text) {
  let key = String(text ?? '').trim();
  const env = key.match(/^(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*([\s\S]*)$/);
  if (env) key = env[1].trim();
  key = key.replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  if (!key) throw new Error(t('沒有貼上 key', 'No key was pasted'));
  if (/\s/.test(key)) throw new Error(t('貼上的不像一把 key（中間有空白或換行）：只複製 key 本身再貼一次', "That doesn't look like a key (it has spaces or line breaks): copy just the key and paste it again"));
  return key;
}

function keychain() {
  const security = process.env.VOICE_DICTATION_SECURITY_BIN || '/usr/bin/security';
  const run = (args) => execFileSync(security, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    read(provider) {
      try {
        return run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', provider, '-w']).trim();
      } catch {
        return ''; // 沒有這筆（exit 44）：當成沒存
      }
    },
    write(provider, key) {
      try {
        run(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', provider, '-l', `JarvisVoice ${OWN_KEY_NAMES[provider]} key`, '-w', key]);
      } catch (err) {
        const detail = String(err.stderr || err.message).trim();
        throw new Error(t(`key 存不進鑰匙圈：${detail}`, `Couldn't save the key to the Keychain: ${detail}`));
      }
    },
    clear(provider) {
      try { run(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', provider]); } catch { /* 本來就沒有 */ }
    },
  };
}

function secretFile(file) {
  const all = () => {
    try { return JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
  };
  const save = (keys) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(keys), { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
  };
  return {
    read: (provider) => String(all()[provider] ?? ''),
    write(provider, key) { save({ ...all(), [provider]: key }); },
    clear(provider) {
      const keys = all();
      delete keys[provider];
      if (Object.keys(keys).length) save(keys);
      else try { unlinkSync(file); } catch { /* 本來就沒有 */ }
    },
  };
}

// key 放哪：macOS 鑰匙圈，其他系統放只有自己讀得到的檔案（VOICE_DICTATION_TOKEN_STORE=file／keychain 可以指定）。都是同步的，讀設定時用得到
export function ownKeyStore(stateDir, { kind = process.env.VOICE_DICTATION_TOKEN_STORE || (process.platform === 'darwin' ? 'keychain' : 'file') } = {}) {
  const indexFile = join(stateDir, OWN_KEYS_FILE);
  const backend = kind === 'keychain' ? keychain() : secretFile(join(stateDir, SECRET_FILE));
  const readIndex = () => {
    try {
      const index = JSON.parse(readFileSync(indexFile, 'utf8'));
      return index && typeof index === 'object' ? index : {};
    } catch {
      return {};
    }
  };
  const writeIndex = (index) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(`${indexFile}.tmp`, `${JSON.stringify(index, null, 2)}\n`);
    renameSync(`${indexFile}.tmp`, indexFile);
  };
  const check = (provider) => {
    if (!OWN_KEY_PROVIDERS.includes(provider)) throw new Error(t(`只能設定 ${OWN_KEY_PROVIDERS.join('、')} 的 key`, `Keys can only be set for ${OWN_KEY_PROVIDERS.join(', ')}`));
  };
  const saved = () => OWN_KEY_PROVIDERS.filter((p) => readIndex()[p]);
  return {
    kind,
    saved,
    read: (provider) => (readIndex()[provider] ? backend.read(provider) : ''),
    // 讀設定時用：存了 key 的那幾家 { openai: 'sk-…' }（鑰匙圈裡被手動刪掉的就沒有）
    readAll: () => Object.fromEntries(saved().map((p) => [p, backend.read(p)]).filter(([, key]) => key)),
    // 先存 key 再記索引：常駐程式看到索引改了去讀時，key 已經在了
    write(provider, key) {
      check(provider);
      mkdirSync(stateDir, { recursive: true });
      backend.write(provider, key);
      writeIndex({ ...readIndex(), [provider]: { at: new Date().toISOString() } });
    },
    clear(provider) {
      check(provider);
      backend.clear(provider);
      const index = readIndex();
      delete index[provider];
      writeIndex(index);
    },
  };
}
