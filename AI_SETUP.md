# 給 AI 的設定指南：JarvisVoice

> For AI assistants: this guide is written in Traditional Chinese. Follow it as written, and talk to the user in the user's own language.

你是使用者的 AI 助理（要能在使用者的 Mac 上讀寫檔案、跑終端機指令，例如 Claude Code、Codex）。使用者已經裝好並開著「JarvisVoice」小程式，要你幫他設定。分兩部分，照順序做，做完回報結果：

- **第一部分：專有名詞**（一定要做）。把**他自己常講的專有名詞**寫進詞彙表，再實際測試，讓轉出來的字更準。
- **第二部分：AI 整理、自動找輸入框、語音指令**（先問他要不要）。選 AI（OpenAI、DeepSeek、Claude）、放 key、打開開關、跑檢查。

**key 的規則（兩部分都適用）：**
- 不要叫使用者把 key 貼進對話；請他從選單「設定自己的 key…」貼，或由他自己在終端機貼（下面有指令），你不經手、不印出來、不寫進 log。
- key 檔放在 `~/.config/jarvis-voice/`，權限 600；不要放進 `~/jarvis-voice`（那是 git repo）。

# 第一部分：專有名詞

## 要動的檔案

都在 `~/.voice-dictation/`。改完存檔，JarvisVoice 幾秒內就會套用，不用重開。

| 檔案 | 內容 |
|---|---|
| `vocabulary.txt` | 專有名詞，一行一個，`#` 後面是註解。用 OpenAI 引擎時會當成 `keywords` 送出；開了 AI 整理時 AI 也照這些寫法改字。「# 自動學到」區是使用者貼上後自己改掉的詞，不要刪 |
| `config.json` | 設定檔；這次要動的是 `openai.prompt`、`openai.languages`、`replacements` |
| `test-sentences.txt` | 測試句，一行一句，`#` 後面是註解 |

測試指令在小程式的程式資料夾裡。用終端機裝的在 `~/jarvis-voice`，下面的指令照寫；下載版（.dmg、Homebrew 裝的）在 `/Applications/JarvisVoice.app/Contents/Resources/app`，Node 也在 app 裡，這份文件裡的 `node ~/jarvis-voice/bin/…` 都要換成 `/Applications/JarvisVoice.app/Contents/Resources/node /Applications/JarvisVoice.app/Contents/Resources/app/bin/…`。`vocab-test.mjs` 要 ffmpeg：下載版的使用者沒有的話，請他 `brew install ffmpeg`，或先只寫詞彙表、跳過測試。

```bash
node ~/jarvis-voice/bin/vocab-test.mjs          # 用 macOS 合成語音念測試句
node ~/jarvis-voice/bin/vocab-test.mjs --mic    # 使用者自己念
```

## 步驟

### 1. 找出使用者常講的詞

先從**使用者自己打過、寫過的字**找，因為那就是他會講的話。依你拿得到的來源：

- **Claude Code 的對話紀錄**：`~/.claude/projects/**/*.jsonl`。只取使用者親自打的訊息，也就是 `type` 是 `user`、`turnOrigin` 是 `human`、`isSidechain` 不是 true 的那幾行；工具輸出和系統訊息都不要。抽法可以參考：

  ```python
  import json, glob, os, time
  cutoff = time.time() - 60 * 86400
  for path in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'), recursive=True):
      if os.path.getmtime(path) < cutoff: continue
      for line in open(path, 'rb'):
          if b'"turnOrigin":"human"' not in line: continue
          d = json.loads(line)
          c = d.get('message', {}).get('content')
          if isinstance(c, str) and not d.get('isSidechain') and len(c) <= 400:
              print(c.replace('\n', ' '))
  ```

- **Codex 的紀錄**：`~/.codex/sessions/`。
- **ChatGPT 匯出的資料**，或使用者給你的筆記、專案文件、README、公司名單。
- 直接問使用者：他做什麼工作、常提到哪些產品、公司、同事、工具。

統計詞頻，英文詞和中文詞分開算，再挑出專有名詞。

### 2. 挑詞的原則

**要放：**
- 產品、公司、品牌名，例如 CubeLV、TestFlight、AStockTeam。
- 英文術語和縮寫，例如 session、prod、onboarding、PR、e2e。
- 程式元件、檔名、指令，例如 cli_worker、item_server。
- 中文裡的專有用語和容易聽錯的同音詞，例如 部署（容易聽成「部屬」）、鑲嵌卡、側欄。
- 使用者自己的簡稱，例如「PS」代表某個產品。

**不要放：**
- 一般中文詞（處理、確認、測試這類，本來就聽得懂）。
- 個資：email、帳號、電話、密碼、金鑰。
- 打錯的字，以及髒話。
- 人名：先問過使用者再放。

**數量：** 50–200 個就好。太多、太雜，反而可能讓模型轉出沒講的詞。

### 3. 寫進設定

- **`vocabulary.txt`**：分類寫，加上註解說明出處或意思。
- **`config.json` 的 `openai.prompt`**：用一兩句話描述場合，例如「台灣工程師用中文夾英文對 AI 程式助理口述指令，內容是某某產品的開發與營運」。不要把詞彙清單塞進 prompt，詞彙放 `vocabulary.txt` 就好。
- **`config.json` 的 `openai.languages`**：填使用者會講的語言，例如台灣中文夾英文就是 `["zh-tw", "en"]`。
- **`config.json` 的 `replacements`**：測試後仍然固定錯的寫法才放這裡，例如 `{ "部屬": "部署" }`。

這一部分只改上面這幾個欄位；AI 整理、key 的設定在第二部分。

### 4. 寫測試句

在 `test-sentences.txt` 寫 10–15 句：
- 用使用者平常講話的口氣，最好直接改寫他打過的句子。
- 每句帶 1–3 個詞彙表裡的詞。
- 也要涵蓋中英夾雜的句子。

### 5. 測試、調整、再測

跑 `node ~/jarvis-voice/bin/vocab-test.mjs`。它會把每一句「不加詞彙」和「加詞彙」各轉一次，跟原文比對，另外再跑一句不含專有名詞的一般句和一段雜音，檢查會不會冒出沒講的詞。

依結果調整：

| 狀況 | 怎麼改 |
|---|---|
| 加了詞彙還是錯 | 確認那個詞有在 `vocabulary.txt`；還是固定錯成同一種寫法，就加進 `replacements` |
| 出現「沒講卻出現」的詞 | 把那個詞從詞彙表拿掉，或換成更具體的寫法 |
| 一般句或雜音轉出了詞彙 | 詞彙太多或太泛，刪掉一般性的詞 |

注意：合成語音念英文縮寫常常念錯（例如把 dev 念成怪音），這類錯誤不代表真人講也會錯，最後要用使用者自己的聲音確認。

### 6. 請使用者親自念一次

請使用者在終端機跑 `node ~/jarvis-voice/bin/vocab-test.mjs --mic`。指令每次印出一句，使用者念完停一下，就會換下一句。用真人聲音的結果才是準的；有錯就照第 5 步再調。

### 7. 回報

告訴使用者這幾件事：
- 詞彙表有幾個詞、分成哪幾類。
- 加詞彙前後的整句全對數，以及平均字錯誤率。
- 有沒有代造詞（沒講卻出現的詞）。
- 還有哪些詞容易錯，建議他之後怎麼加。

# 第二部分：AI 整理、自動找輸入框、語音指令

### 8. 三層預設都開：跟使用者講清楚會做什麼、會送出什麼，問他要不要關掉哪一層

| 功能 | 做什麼 | 會送出去的東西 |
|---|---|---|
| AI 整理 | 一段話講完（停約 2 秒），交給 AI 整理再寫進去（會參考畫面上看得到的字判斷在討論什麼）；詞彙表會從畫面和他的改字自動加新的專有名詞（有上限）：去贅字、「三點，不對，四點」只留四點、條列、依 app 調語氣、照詞彙表的寫法；選起一段字講「改正式一點」會改寫那段；講「換回原文」或點選單「換回原文」可以換回轉寫原稿 | 游標前後各 400 字、選取的字、視窗裡看得到的字（最後約 1,500 字）、app 名稱、視窗標題、網址，送到他選的 AI |
| 自動找輸入框 | 游標不在輸入框時，由決策器從視窗裡所有輸入框挑一個寫進去 | 視窗裡輸入框的標籤和位置（送給決策器） |
| 語音指令 | 講「打開設定」「搜尋某某」，直接操作最前面的 app；游標在輸入框裡時由 Jev 看畫面判斷是要打字還是要操作，開頭講「指令，……」一定當指令；決策器信心太低就停，按「暫停收音」也會停 | 畫面上按鈕、連結、輸入框的名稱（送給決策器）；要先開 AI 整理 |

都只對最前面的 app 動作，選單隨時可以關。費用：一天講 1 小時，AI 整理一個月不到 1 美元（轉寫本身另計）。

### 9. 選 AI

| 選項 | 速度 | key 從哪來 | 說明 |
|---|---|---|---|
| OpenAI | 約 1.1 秒 | 跟轉寫同一把（用 `openai` 引擎的人已經有了） | 不用另外申請，最省事 |
| DeepSeek | 約 0.75 秒，最快 | https://platform.deepseek.com 申請 API key、儲值 | 台灣平日 9–12、14–18 點價格加倍，仍然很便宜 |
| Claude | 約 0.85 秒 | https://console.anthropic.com 申請 API key | |
| 用 CubeLV 登入 | 約 1 秒 | 不用 key，扣 CubeLV 帳號的點數 | 有 CubeLV 帳號、不想自己管 key 的人；請他從選單按「用 CubeLV 登入…」在瀏覽器按允許，第 10、11 步的 key 都跳過 |

使用者沒有偏好就建議：已經用 OpenAI 轉寫的選 OpenAI；想要最快的選 DeepSeek。

### 10. 放 key（OpenAI 而且轉寫已經有 key 的、用 CubeLV 登入的，跳過這步）

最簡單的是請使用者點選單列的 JarvisVoice →「設定自己的 key…」，選他挑的那家、貼上 key、按「測試並儲存」：小程式會先實際打一次，通了才存進 macOS 鑰匙圈（不寫進設定檔），並把 AI 整理切到那家（OpenAI 的轉寫要他勾「轉寫也改用 OpenAI」才換）。用選單存的話，第 11 步不用寫 `keyFiles`／`keyCommands`，只要確認 `autoFocus`、`commands` 照他的選擇。偏好終端機的，`node ~/jarvis-voice/bin/set-key.mjs set deepseek`（換成他選的那家）做的事一樣，貼上時畫面不顯示。

不想用鑰匙圈、或想自己管 key 檔的，請使用者自己在終端機跑下面這行，把 key 貼進去（貼的時候畫面不會顯示）。把 `DEEPSEEK_API_KEY`、`deepseek.env` 換成他選的那家：DeepSeek 用 `DEEPSEEK_API_KEY`，Claude 用 `ANTHROPIC_API_KEY`，OpenAI 用 `OPENAI_API_KEY`。

```bash
mkdir -p ~/.config/jarvis-voice && read -s "KEY?貼上 key 後按 Enter：" && printf 'DEEPSEEK_API_KEY=%s\n' "$KEY" > ~/.config/jarvis-voice/deepseek.env && chmod 600 ~/.config/jarvis-voice/deepseek.env && unset KEY && echo 已存好
```

key 已經放在密碼管理或雲端的，改用指令拿，key 不落地（設定檔的 `ai.keyCommands`）：

| 放在哪 | 指令例子 |
|---|---|
| 1Password（要裝 `op`） | `op read "op://Private/DeepSeek/credential"` |
| macOS 鑰匙圈 | `security find-generic-password -s deepseek-api -w` |
| AWS SSM | `aws ssm get-parameter --name /my/DEEPSEEK_API_KEY --with-decryption --query Parameter.Value --output text` |

不要用環境變數：小程式是從 Finder 或開機自動啟動的，讀不到 `.zshrc` 裡設的變數。

### 11. 寫進設定檔

在 `~/.voice-dictation/config.json` **加上**下面的欄位，原本的欄位（`engine`、`openai` 等）都留著。照使用者的選擇改 `provider` 和 key 的位置；自動找輸入框、語音指令他不要的就給 `false`。

```json
{
  "ai": {
    "enabled": true,
    "provider": "deepseek",
    "keyFiles": { "deepseek": "~/.config/jarvis-voice/deepseek.env" }
  },
  "autoFocus": true,
  "commands": true
}
```

- 第 10 步用選單「設定自己的 key…」存的：`ai` 裡的 `keyFiles` 整行不用寫，`provider` 也已經切好了。
- 用 `keyCommands` 的話把 `keyFiles` 換成 `"keyCommands": { "deepseek": "<上表的指令>" }`。
- 選 OpenAI 而且轉寫已經有 key：只要 `"ai": { "enabled": true, "provider": "openai" }`。
- 用 CubeLV 登入：登入時會自己寫好，不用改設定檔；只要確認 `autoFocus`、`commands` 照他的選擇。
- 存檔後幾秒內自動套用。之後要換家、開關功能，直接用選單「AI 整理」「自動找輸入框」「語音指令」。
- 想調語氣可以加 `ai.styles`，例如 `{ "com.tinyspeck.slackmacgap": "口語、簡短" }`（key 是 app 的 bundle id 或網站網域）；沒寫會用內建的聊天、email、給 AI 的指令、文件四種語氣。
- **Jev（選用）**：自動找輸入框和語音指令的決策器，一步約 0.2 秒。TypeSafe（https://typesafe.ai）的 key，可能暫停註冊中。有的話請使用者從選單「設定自己的 key…」選 TypeSafe Jev 貼上，或照第 10 步存成 `~/.config/jarvis-voice/jev.env`（變數名 `TYPESAFE_API_KEY`），設定檔加 `"jev": { "apiKeyFile": "~/.config/jarvis-voice/jev.env" }`。沒有也能用，會改問上面選的 AI，一步約 1 秒。

### 12. 檢查

```bash
node ~/jarvis-voice/bin/ai-check.mjs
```

它會照設定檔實際打一次 AI 和決策器（不印 key）。正常的樣子：

```
AI 整理：開，用 DeepSeek（deepseek-flash）
整理測試（697 ms）：「嗯那個我們明天三點開會，不對，四點開會，然後記得帶那個筆電」→「我們明天四點開會，記得帶筆電。」
自動找輸入框：開；語音指令：開
第三層決策（Jev，202 ms）：「進到台積電的個股頁」判成 指令
都正常。
```

有問題它會說缺什麼（例如沒有 key、key 錯了 HTTP 401），照著改設定檔再跑一次。

然後請使用者實際試：
- 在任何輸入框講一段話，停約 2 秒，看寫進去的字有沒有整理過。
- 點掉輸入框（例如點網頁空白處）再講一段話，看會不會寫進對的框。
- 開了語音指令的話，講「打開設定」或「指令，搜尋某某」。

選單第一行會寫「講完一段，DeepSeek 整理後寫進輸入框」；「AI 整理」後面出現「（沒有 key）」就是 key 沒讀到。細節記錄在 `~/.voice-dictation/listen.log`。

### 13. 回報

告訴使用者：
- 用哪家 AI、key 放在哪（只講位置，不講 key）。
- `ai-check.mjs` 的結果，以及他實際試的結果。
- 自動找輸入框、語音指令有沒有開，怎麼從選單關掉。
- 會送出去的東西（第 8 步的表），以及大概的費用。
