#!/usr/bin/env bash
# JarvisVoice（macOS）：安裝或更新。
#   ./install.sh                 用設定檔現在的引擎（第一次裝是 local）
#   ./install.sh local           本機辨識（免費，聲音不離開這台電腦）
#   ./install.sh openai          自己的 OpenAI key，預設一般轉寫 gpt-transcribe（OPENAI_API_KEY 有設就順手寫進設定檔）
#   ./install.sh parallelsandbox 平行沙盒帳號
# 會做：裝套件、補模型、寫設定、包出「JarvisVoice.app」放進 ~/Applications、設成開機自動啟動、打開它。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${VOICE_DICTATION_STATE_DIR:-$HOME/.voice-dictation}"
CONFIG="$STATE/config.json"
APP="${VOICE_DICTATION_APP:-$HOME/Applications/JarvisVoice.app}"
AGENT="$HOME/Library/LaunchAgents/com.urusa.voice-dictation.plist"
ENGINE="${1:-}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

case "$ENGINE" in ''|local|openai|parallelsandbox) ;; *) fail "引擎只能是 local、openai、parallelsandbox。" ;; esac

say "檢查環境"
[[ "$(uname -s)" == Darwin ]] || fail "目前只支援 macOS。"
command -v node >/dev/null || fail "需要 Node.js 22 以上：brew install node，或到 https://nodejs.org 下載。"
NODE="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || fail "Node.js 太舊（$(node -v)），需要 22 以上。"
FFMPEG=""
for p in /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg "$(command -v ffmpeg || true)"; do
  [[ -n "$p" && -x "$p" ]] && { FFMPEG="$p"; break; }
done
[[ -n "$FFMPEG" ]] || fail "需要 ffmpeg 收音：brew install ffmpeg"
note "node $(node -v)（${NODE}）、ffmpeg $FFMPEG"

say "安裝套件"
(cd "$DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

# 舊版（綁在 Claude Code 上的 mod）的資料搬過來
if [[ ! -d "$STATE" && -d "$HOME/.claude/voice-dictation" ]]; then
  mv "$HOME/.claude/voice-dictation" "$STATE"
  note "設定、詞彙、模型從 ~/.claude/voice-dictation 搬到 $STATE"
fi
mkdir -p "$STATE"

if [[ -z "$ENGINE" ]]; then
  if [[ -f "$CONFIG" ]]; then
    ENGINE="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).engine||"local")}catch{process.stdout.write("local")}' "$CONFIG")"
  else
    ENGINE="local"
  fi
fi

# 模型網址與下載都在 bin/models.mjs（.app 第一次打開的設定畫面也用它），缺的才下載
export VOICE_DICTATION_STATE_DIR="$STATE"
if [[ "$ENGINE" == local ]]; then
  say "本機辨識模型 SenseVoice-Small（約 155 MB，來源 k2-fsa/sherpa-onnx）"
  node "$DIR/bin/models.mjs" local || fail "本機辨識模型沒下載成功，再跑一次 install.sh。"
fi

# 「只聽我的聲音」用的聲紋模型（CAM++ 中文，約 28 MB）：不論哪個引擎都裝，選單開了才會用
say "聲紋模型 CAM++（約 28 MB，來源 k2-fsa/sherpa-onnx）"
node "$DIR/bin/models.mjs" speaker || say "聲紋模型沒下載成功（之後重跑 install.sh 再裝）；「只聽我的聲音」先不能用"

say "設定檔：${CONFIG}（引擎 ${ENGINE}）"
node - "$CONFIG" "$ENGINE" <<'EOF'
const fs = require('fs');
const [file, engine] = process.argv.slice(2);
let config = {};
try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
config.engine = engine;
// 舊版只在 Claude 桌面版收音；單獨小程式改成全部 app
if (JSON.stringify(config.apps) === JSON.stringify(['com.anthropic.claudefordesktop'])) delete config.apps;
if (engine === 'openai' && process.env.OPENAI_API_KEY && !config.openai?.apiKey && !config.openai?.apiKeyFile) {
  config.openai = { ...config.openai, apiKey: process.env.OPENAI_API_KEY };
}
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
EOF
if [[ "$ENGINE" == openai ]] && ! grep -q '"apiKey": "sk-\|"apiKeyFile"' "$CONFIG" && ! grep -qs '"openai"' "$STATE/own-keys.json" && [[ -z "${OPENAI_API_KEY:-}" ]]; then
  note "還沒有 OpenAI key：裝好後點選單列的 JarvisVoice →「設定自己的 key…」選 OpenAI 貼上；或在 $CONFIG 的 openai 裡加上 \"apiKeyFile\": \"放 key 的檔案路徑\""
fi

# 舊版註冊在 Claude Code 的 plugin 拿掉
if command -v claude >/dev/null && claude plugin list 2>/dev/null | grep -q "voice-dictation@claude-voice-dictation"; then
  claude plugin uninstall "voice-dictation@claude-voice-dictation" >/dev/null 2>&1 || true
  claude plugin marketplace remove claude-voice-dictation >/dev/null 2>&1 || true
  note "已移除舊版的 Claude Code plugin"
fi

say "選單列小程式：$APP"
# 舊名稱「全語音輸入.app」「語音輸入.app」改名過來
for OLD in "$HOME/Applications/全語音輸入.app" "$HOME/Applications/語音輸入.app"; do
  if [[ -d "$OLD" && ! -d "$APP" ]]; then
    pkill -f "$OLD/Contents/MacOS/applet" 2>/dev/null || true
    mv "$OLD" "$APP"
    note "舊的 $(basename "$OLD") 改名成 $(basename "$APP")"
  fi
done
pkill -f "$APP/Contents/MacOS/applet" 2>/dev/null || true
# 小程式本身沒變就不重包：沒有開發者憑證時是本機簽名，重包會換簽名，麥克風與輔助使用權限得重新允許
STAMP="$(printf '%s\n%s\n%s\n%s\n' "$(shasum -a 256 "$DIR/app/main.js" "$DIR/app/build.sh" | cut -d' ' -f1 | tr '\n' ' ')" "$NODE" "$DIR" "$STATE" | shasum -a 256 | cut -d' ' -f1)"
if [[ -f "$APP/Contents/Resources/build-stamp" && "$(cat "$APP/Contents/Resources/build-stamp")" == "$STAMP" ]]; then
  note "沒有變動，沿用原本的 app（權限不用重給）"
else
  BUILD_STAMP="$STAMP" "$DIR/app/build.sh" "$APP" "$DIR" "$NODE" "$STATE"
  if codesign -dv "$APP" 2>&1 | grep -q '^Signature=adhoc'; then
    note "已包好（本機簽名：第一次用或小程式有更新時，系統會再問一次權限）"
  else
    note "已包好（開發者憑證簽名：權限給過一次，之後重包不用重給）"
  fi
fi

mkdir -p "$(dirname "$AGENT")"
cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.urusa.voice-dictation</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>$APP</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
note "開機自動啟動：$AGENT"

open "$APP"

say "完成：選單列出現 JarvisVoice 的圖示（循環箭頭包住三條聲波）就是在跑了"
cat <<EOF
  第一次用要給兩個權限（只要一次）：
  1. 麥克風：跳出「JarvisVoice 想要取用麥克風」時按允許。
  2. 輔助使用（貼上要用）：第一次講話時會跳出詢問，到「系統設定 → 隱私權與安全性 → 輔助使用」打開「JarvisVoice」。

  第二步：請你常用的 AI 幫你設定，直接把這句話貼給它：
    請照 $DIR/AI_SETUP.md 幫我設定 JarvisVoice：填專有名詞並跑測試，也問我要不要開 AI 整理、自動找輸入框、語音指令，要的話幫我設定好並檢查。
EOF
