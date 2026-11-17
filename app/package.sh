#!/usr/bin/env bash
# 打包下載版的 JarvisVoice（Apple Silicon，macOS 14 以上）：Node、程式、正式相依、編好的收音小幫手都包在 .app 裡，
# 對方不用另裝 git、Node、ffmpeg、Xcode。用 Developer ID 簽章（hardened runtime）、送公證、staple。
# 用 install.sh 裝的（app/build.sh）照舊：那份 .app 只是外殼，程式讀 repo 裡的。
#
# 用法：app/package.sh [--version 1.0.0] [--node <node 執行檔>] [--out <資料夾>] [--bundle-id <id>] [--unsigned] [--no-notarize]
#   --node       包進去的 Node（要 arm64、22 以上）；沒給就從 nodejs.org 下載 NODE_VERSION（長期支援版），照官方的 SHASUMS256.txt 核對
#   --unsigned   本機簽名、不公證（只在這台試）
# 簽章用鑰匙圈裡第一張 Developer ID Application（JARVIS_SIGN_IDENTITY 可指定）。
# 公證二選一：NOTARY_PROFILE（notarytool store-credentials 存的名字），或 NOTARY_KEY（.p8 路徑）＋NOTARY_KEY_ID＋NOTARY_ISSUER。
# 產出（<out>，預設 dist/）：JarvisVoice-<版號>.dmg 與同一份的 JarvisVoice.dmg（給人下載；後者是官網的固定網址用）、
# JarvisVoice-<版號>-update.zip（App 內更新用）、SHA256SUMS、
# jarvis-voice.rb（Homebrew cask，放進自家 tap）
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$REPO/package.json').version")"
NODE_VERSION="26.13.1" # 包進去的 Node：用長期支援版（2026-11 是 26 Lithium），升級時改這裡
NODE=""
OUT="$REPO/dist"
BUNDLE_ID="com.urusa.voice-dictation"
SIGN=1
NOTARIZE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --unsigned) SIGN=0; NOTARIZE=0; shift ;;
    --no-notarize) NOTARIZE=0; shift ;;
    *) echo "不認得的參數：$1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# 沒指定 Node 就下載官方的 NODE_VERSION（darwin-arm64），雜湊對過才用；下載過的放在 dist/.node 重用
if [[ -z "$NODE" ]]; then
  CACHE="$REPO/dist/.node/v$NODE_VERSION"
  NODE="$CACHE/node"
  if [[ ! -x "$NODE" ]]; then
    say "下載 Node ${NODE_VERSION}（nodejs.org）"
    TAR="node-v$NODE_VERSION-darwin-arm64.tar.gz"
    DL="$(mktemp -d)"
    curl -fsSL --retry 3 -o "$DL/$TAR" "https://nodejs.org/dist/v$NODE_VERSION/$TAR"
    curl -fsSL --retry 3 -o "$DL/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
    (cd "$DL" && grep " $TAR\$" SHASUMS256.txt | shasum -a 256 -c -) || fail "Node 的雜湊對不上，不用"
    tar -xzf "$DL/$TAR" -C "$DL"
    mkdir -p "$CACHE"
    mv "$DL/node-v$NODE_VERSION-darwin-arm64/bin/node" "$NODE"
    rm -rf "$DL"
  fi
fi

[[ -x "$NODE" ]] || fail "找不到 Node：用 --node 指定"
lipo -archs "$NODE" | grep -qw arm64 || fail "$NODE 不是 arm64"
(( $("$NODE" -p 'process.versions.node.split(".")[0]') >= 22 )) || fail "Node 要 22 以上（$("$NODE" -v)）"
if (( SIGN )); then
  IDENTITY="${JARVIS_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | grep -m1 '"Developer ID Application: ' | awk '{print $2}' || true)}"
  [[ -n "$IDENTITY" ]] || fail "鑰匙圈沒有 Developer ID Application 憑證（或用 --unsigned）"
else
  IDENTITY="-"
fi
if (( NOTARIZE )); then
  if [[ -n "${NOTARY_PROFILE:-}" ]]; then NOTARY=(--keychain-profile "$NOTARY_PROFILE")
  elif [[ -n "${NOTARY_KEY:-}" && -n "${NOTARY_KEY_ID:-}" && -n "${NOTARY_ISSUER:-}" ]]; then NOTARY=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
  else fail "沒有公證的帳號：設 NOTARY_PROFILE，或 NOTARY_KEY＋NOTARY_KEY_ID＋NOTARY_ISSUER（或加 --no-notarize）"; fi
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/JarvisVoice.app"
RES="$APP/Contents/Resources"
PLIST="$APP/Contents/Info.plist"

say "外殼（osacompile）：JarvisVoice ${VERSION}，$BUNDLE_ID"
# 下載版的 BUILD 填 null：路徑由 app/main.js 照 .app 自己的位置算
sed 's/__BUILD__/null/' "$REPO/app/main.js" > "$STAGE/main.js"
osacompile -l JavaScript -s -o "$APP" "$STAGE/main.js"

set_key() { plutil -replace "$1" "-$2" "$3" "$PLIST"; }
set_key CFBundleIdentifier string "$BUNDLE_ID"
set_key CFBundleName string JarvisVoice
set_key CFBundleDisplayName string JarvisVoice
set_key CFBundleShortVersionString string "$VERSION"
set_key CFBundleVersion string "$VERSION"
set_key LSUIElement bool true
set_key LSMinimumSystemVersion string 14.0
set_key CFBundleIconFile string AppIcon
set_key NSHumanReadableCopyright string "MIT License"
set_key NSMicrophoneUsageDescription string "JarvisVoice listens to what you say and types it into the app you're using, or operates the app when you give a command."
set_key NSAppleEventsUsageDescription string "JarvisVoice sends Paste (Cmd+V) to put text into the text field."
# osacompile 給每個 applet 的通用權限說明與舊鍵：用不到的拿掉；圖示換成自己的（有 CFBundleIconName 時系統會用 Assets.car 的那個）
for key in CFBundleIconName LSRequiresCarbon LSMinimumSystemVersionByArchitecture NSHomeKitUsageDescription NSAppleMusicUsageDescription \
  NSCalendarsUsageDescription NSSiriUsageDescription NSCameraUsageDescription NSRemindersUsageDescription NSContactsUsageDescription \
  NSPhotoLibraryUsageDescription NSSystemAdministrationUsageDescription; do
  plutil -remove "$key" "$PLIST" 2>/dev/null || true
done
rm -f "$RES/applet.icns" "$RES/Assets.car"
# 系統跳權限詢問時的說明照系統語言
mkdir -p "$RES/en.lproj" "$RES/zh-Hant.lproj"
printf '"NSMicrophoneUsageDescription" = "JarvisVoice listens to what you say and types it into the app you’re using, or operates the app when you give a command.";\n"NSAppleEventsUsageDescription" = "JarvisVoice sends Paste (Cmd+V) to put text into the text field.";\n' > "$RES/en.lproj/InfoPlist.strings"
printf '"NSMicrophoneUsageDescription" = "JarvisVoice 要用麥克風聽你講話，轉成文字寫進輸入框，或照你講的操作 app。";\n"NSAppleEventsUsageDescription" = "JarvisVoice 要送出貼上（Cmd+V），把字放進輸入框。";\n' > "$RES/zh-Hant.lproj/InfoPlist.strings"

say "圖示"
osascript -l JavaScript "$REPO/app/make-icon.js" "$REPO" "$STAGE/AppIcon.iconset" >/dev/null
iconutil -c icns -o "$RES/AppIcon.icns" "$STAGE/AppIcon.iconset"

say "程式與正式相依"
mkdir -p "$RES/app/app" "$RES/app/node_modules"
cp "$REPO/app/ui.js" "$REPO/app/onboarding.js" "$RES/app/app/"
rsync -a --exclude 'mic-capture' "$REPO/bin/" "$RES/app/bin/"
rsync -a "$REPO/core/" "$RES/app/core/"
cp "$REPO/package.json" "$REPO/LICENSE" "$REPO/AI_SETUP.md" "$RES/app/"
while IFS= read -r dir; do
  rel="node_modules/${dir#*/node_modules/}"
  mkdir -p "$RES/app/$(dirname "$rel")"
  rsync -a "$dir/" "$RES/app/$rel/"
done < <(cd "$REPO" && npm ls --omit=dev --all --parseable | grep '/node_modules/')
"$NODE" -e 'require(process.argv[1])' "$RES/app/node_modules/sherpa-onnx-node" || fail "包進去的 sherpa-onnx-node 載入失敗"

say "收音小幫手（swiftc）"
swiftc -O -target arm64-apple-macos14 "$REPO/bin/mic-capture.swift" -o "$RES/app/bin/mic-capture"

say "Node $("$NODE" -v)"
cp "$NODE" "$RES/node"
chmod 755 "$RES/node"

say "簽章（$([[ "$IDENTITY" == - ]] && echo 本機簽名 || echo Developer ID)）"
# 本機簽名不開 hardened runtime：沒有 Team ID，開了 Node 就載不進原生模組（library validation）。
# Developer ID 要 Apple 的時間戳記（timestamp.apple.com）才能公證：一時連不上就再試兩次
sign() {
  if [[ "$IDENTITY" == - ]]; then codesign --force --sign - "$@"; return; fi
  for try in 1 2 3; do
    codesign --force --timestamp --options runtime --sign "$IDENTITY" "$@" && return
    sleep 10
  done
  fail "簽章失敗（Apple 的時間戳記服務 timestamp.apple.com 連不上時也會這樣，等一下再打）"
}
# 裡面的程式碼先簽，最後簽整個 .app
while IFS= read -r -d '' file; do
  file -b "$file" | grep -q 'Mach-O' && sign "$file"
done < <(find "$RES/app/node_modules" -type f \( -name '*.node' -o -name '*.dylib' \) -print0)
sign --entitlements "$REPO/app/entitlements/mic.plist" "$RES/app/bin/mic-capture"
sign --entitlements "$REPO/app/entitlements/node.plist" "$RES/node"
sign --entitlements "$REPO/app/entitlements/app.plist" "$APP"
codesign --verify --deep --strict "$APP"

notarize() {
  local result id status
  result="$(xcrun notarytool submit "$1" "${NOTARY[@]}" --wait --output-format json)"
  id="$(plutil -extract id raw - <<<"$result")"
  status="$(plutil -extract status raw - <<<"$result")"
  if [[ "$status" != Accepted ]]; then
    xcrun notarytool log "$id" "${NOTARY[@]}" >&2 || true
    fail "公證沒過：$(basename "$1") ${status}（${id}）"
  fi
  echo "  公證通過：$(basename "$1")（${id}）"
}

mkdir -p "$OUT"
DMG="$OUT/JarvisVoice-$VERSION.dmg"
ZIP="$OUT/JarvisVoice-$VERSION-update.zip"
if (( NOTARIZE )); then
  say "公證 .app（等 Apple 回覆，通常幾分鐘）"
  ditto -c -k --keepParent "$APP" "$STAGE/notarize.zip"
  notarize "$STAGE/notarize.zip"
  xcrun stapler staple -q "$APP"
fi

say "App 內更新用的 zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

say ".dmg"
mkdir "$STAGE/dmg"
ditto "$APP" "$STAGE/dmg/JarvisVoice.app"
ln -s /Applications "$STAGE/dmg/Applications"
rm -f "$DMG"
hdiutil create -quiet -volname JarvisVoice -srcfolder "$STAGE/dmg" -format ULFO "$DMG"
if [[ "$IDENTITY" != - ]]; then codesign --force --timestamp --sign "$IDENTITY" "$DMG"; fi
if (( NOTARIZE )); then
  say "公證 .dmg"
  notarize "$DMG"
  xcrun stapler staple -q "$DMG"
  spctl -a -t execute "$APP" || fail "Gatekeeper 不認 .app"
  spctl -a -t open --context context:primary-signature "$DMG" || fail "Gatekeeper 不認 .dmg"
fi

# 官網、README 的下載鈕用 releases/latest/download/JarvisVoice.dmg（GitHub 轉到最新版的同名檔），所以每版另放一份固定檔名的
cp "$DMG" "$OUT/JarvisVoice.dmg"
(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" "$(basename "$ZIP")" JarvisVoice.dmg > SHA256SUMS)

# Homebrew cask（自家 tap 用：發布時把這個檔放進 tap repo 的 Casks/）；下載點是 GitHub Release 上的 .dmg
cat > "$OUT/jarvis-voice.rb" <<CASK
cask "jarvis-voice" do
  version "$VERSION"
  sha256 "$(shasum -a 256 "$DMG" | cut -d' ' -f1)"

  url "https://github.com/urusaqqrun/jarvis-voice/releases/download/v#{version}/JarvisVoice-#{version}.dmg"
  name "JarvisVoice"
  desc "Always-on voice typing that types into the app you're using"
  homepage "https://jarvis-voice.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: ">= :sonoma"

  app "JarvisVoice.app"

  zap trash: [
    "~/.voice-dictation",
    "~/Library/Preferences/com.urusa.voice-dictation.plist",
  ]
end
CASK

say "完成"
ls -l "$DMG" "$ZIP" "$OUT/jarvis-voice.rb"
