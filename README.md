# JarvisVoice: hands-free voice typing and app control

English ｜ [繁體中文](README.zh-TW.md)

<img src="design/icon-big.png" width="96" alt="JarvisVoice menu bar icon: a circular arrow around three sound bars">

Website: [jarvis-voice.com](https://jarvis-voice.com)

A macOS menu bar app. While it's running it listens on its own, and what you say goes straight into the app you're using: Claude, ChatGPT, your browser, LINE, Notes, anything.

It works in three layers. All three are on by default, each one builds on the one before, and you can turn layers 2 and 3 off from the menu:

| Layer | When it writes | What it writes | Where it writes |
|---|---|---|---|
| 1. Voice typing | After each sentence (a pause of about 0.85 s) | The raw transcript | The text field your cursor is in; if the cursor isn't in a text field, nothing is written |
| 2. AI cleanup (like [Typeless](https://www.typeless.com)) | After each passage (a pause of about 2 s) | Text cleaned up by AI: filler words removed, self-corrections resolved, lists formatted, tone matched to the app, your own terms spelled right. The AI looks at the text around the cursor, the text visible on screen, the app, the window and the URL. Choose OpenAI, DeepSeek or Claude | Same as layer 1 |
| 3. Auto-focus and voice commands | Same as layer 2 | Same as layer 2 | If the cursor isn't in a text field, it picks the right field in the window and writes there. If what you said is a command such as "open the TSMC stock page", it doesn't type anything; it operates the frontmost app for you. Decisions are made by [Jev](https://typesafe.ai) (or by your AI if you don't have Jev) |

Architecture and measured numbers (in Chinese): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Two steps

**Step 1: install and open the app**

You need macOS, Node.js 22 or later, and ffmpeg (`brew install node ffmpeg`).

```bash
git clone https://github.com/urusaqqrun/jarvis-voice.git ~/jarvis-voice
cd ~/jarvis-voice
./install.sh openai   # OpenAI transcription (most accurate); use ./install.sh local to pay nothing
```

The JarvisVoice icon (a circular arrow around three sound bars) appears in the menu bar. The first time, macOS asks for two permissions, once each:

1. **Microphone**: allow it when "JarvisVoice would like to access the microphone" appears.
2. **Accessibility** (needed to paste): you're asked the first time you speak. Turn on "JarvisVoice" in System Settings → Privacy & Security → Accessibility.
3. **Screen Recording** (optional, only for apps it can't read, such as LINE): you're asked the first time it's needed. Turn on "JarvisVoice" in System Settings → Privacy & Security → Screen Recording.

Pick one of three ways to power transcription and AI cleanup; you can switch any time from the menu:

- **On-device**: free, and your audio never leaves your Mac (`./install.sh local`).
- **Your own keys**: OpenAI transcription is the most accurate; AI cleanup can use OpenAI, DeepSeek or Claude. Choose "Set up your own key…" in the menu, pick a provider and paste your key: it's tested first and saved to the macOS Keychain only if it works (never to the config file), and AI cleanup switches to that provider; OpenAI transcription only switches if you tick the box, otherwise it stays as it is, e.g. on-device (see [Set up your own key](#set-up-your-own-key) below). You can also let your AI set it up in step 2 (you paste the key yourself; the AI never sees it), or add `"apiKeyFile": "<file with your key>"` under `openai` in `~/.voice-dictation/config.json`.
- **Sign in with CubeLV**: no keys needed. Choose "Sign in with CubeLV…" in the menu, and transcription, AI cleanup and voice-command decisions use your [CubeLV](https://cubelv.com) account's credits (see [Sign in with CubeLV](#sign-in-with-cubelv) below).

**Step 2: ask your AI to set it up**

Everyone has their own product names, acronyms and in-house jargon, and those are the words speech recognition gets wrong most. AI cleanup, auto-focus and voice commands also need an AI provider and a key (you can paste the key yourself under "Set up your own key…" in the menu, without the AI). Open an AI that can read files and run commands on your Mac (Claude Code, Codex and the like; ChatGPT on the web can't) and paste this (or edit the config file yourself, see "Config file" below):

> Please follow ~/jarvis-voice/AI_SETUP.md to set up JarvisVoice for me: fill in my vocabulary and run the tests, and ask me whether I want AI cleanup, auto-focus and voice commands; if I do, set them up and check that they work.

The AI will:
- Find the terms you use most in what you've typed before, write them to `~/.voice-dictation/vocabulary.txt`, and run a test comparing accuracy with and without them. In our test of 4 mixed Chinese–English developer sentences, 1/4 came out fully correct without the vocabulary and 4/4 with it.
- Explain what AI cleanup sends and what it costs, ask whether you want OpenAI, DeepSeek or Claude, have you paste your key under "Set up your own key…" in the menu (or into a file only you can read), write the switches to your config, and run `node ~/jarvis-voice/bin/ai-check.mjs` to confirm the AI and the decision maker both work.

## Everyday use

- **Menu bar icon**: normally the JarvisVoice mark (a circular arrow around three sound bars: automatic + voice); when something happens the whole icon switches to a large symbol, so you can tell what's going on at a glance. It keeps a fixed width and the same color as your other menu bar icons:
  - The mark: listening.
  - Five bars moving with your voice: hearing you speak.
  - The circular arrow spinning: transcribing (from when you stop until the text is pasted: transcription plus AI cleanup).
  - Check mark: just pasted.
  - Cross: nothing was written (the cursor wasn't in a text field and no field was found), or a voice command didn't finish.
  - Faded mark: standing by (the frontmost app is excluded).
  - The mark with a slash through it (like a "no" sign): paused, not listening.
  - Triangle with an exclamation mark: something went wrong; open the menu to see why.
- **Types as you talk**: while you speak, text goes straight into the field where your cursor is (on-device preview, updated every 0.5 s). When AI cleanup is ready it replaces that passage, so the text in the field changes only once (the accurate transcript feeds the cleanup; it's written first only for a sentence whose preview fell behind or never appeared), and you can send whenever you like. If you've already sent it, edited it, moved the cursor or switched apps, it stays as it is. It only waits for cleanup when the cursor isn't in a field, text is selected, or you start with "command". Speech that doesn't clearly match your voiceprint waits until the sentence ends. `speed.live: false` waits for the end of each sentence; `speed.draft: false` waits for cleanup.
- **Bubble next to the cursor**: while you talk it shows what it heard that isn't in the field yet (a sentence under 1 s, one whose voiceprint check isn't done, or one the preview hasn't typed yet); once everything is in the field it only shows status (typing as you talk, cleaning up, cleaned up). When the cursor isn't in a field it shows everything it hears, then "Cleaning up" and "Pasted". Voice commands show each step; if nothing was pasted or something failed, it says why. The bubble never takes focus, and clicks go straight through it.
- **When the cursor isn't in a text field** (you're reading a web page, selecting files in Finder): with auto-focus off, nothing is written, the icon briefly shows a cross, and "Copy last sentence" in the menu gets the text back; with auto-focus on, it picks the right field in the window and writes there.
- **Meetings**: it doesn't listen while Zoom, Teams, FaceTime or Webex is frontmost. If people are talking nearby or a video is playing, choose "Pause listening" in the menu.
- **Menu**: pause/resume, copy last sentence, revert to the raw transcript, transcription (on-device / OpenAI / CubeLV / ParallelSandbox), AI cleanup (off / OpenAI / DeepSeek / Claude / CubeLV), auto-focus, voice commands, edit vocabulary, edit config, set up your own key, sign in to / out of CubeLV, help, quit.

## AI cleanup (layer 2)

On by default (it only runs when you have an AI key; without one you get layer 1). Switch providers under "AI cleanup" in the menu, or choose "Off" to go back to sentence-by-sentence pasting. While it's on:

- **Passage by passage**: a pause longer than 1.8 s ends a passage; text appears about 3 s after you stop.
- **What it cleans up**:
  - Removes filler ("um", "uh", "like", "you know", and their Chinese equivalents).
  - "Three o'clock, no, four" keeps only four.
  - "First … second …" becomes a list; saying "new line" inserts a line break.
  - Adds punctuation, keeps your language (English stays English, nothing is translated), writes Chinese in Taiwan Traditional characters.
  - Spells your terms the way your vocabulary file does.
- **Reads the screen**: the last ~1,500 characters visible in the window (for example the conversation you're in, not including the text field) go to the AI. If the screen is about JarvisVoice and you were heard as saying "JavaScript", it fixes it to JarvisVoice; when you really are talking about JavaScript code, it leaves it alone.
- **Reads around the cursor**: if you're continuing half a sentence it carries on from there; if there's text after the cursor it won't add a period.
- **Matches the app's tone**: casual for chat, polished for email, precise for prompts to AI, concise for documents. Customize with `ai.styles`.
- **Rewrites a selection**: select text and say "make it more formal", "shorten it", "translate to English".
- **Fix by voice**: say "delete that" or "revert to original", or choose "Revert to original" in the menu, to swap the last passage back to the raw transcript.
- **Vocabulary keeps itself up to date**: new terms from your screen and from your own corrections go into the "auto-learned" section at the end of the vocabulary file.
  - Not everything it sees: a term on screen has to show up on 3 separate occasions (at least 10 minutes apart), or you have to actually say it, before it's added. Words you correct yourself after pasting are added right away.
  - There's a cap: at most 250 terms in total and 80 auto-learned ones. When it's full, the least used, longest unused auto-learned term goes first. Terms you wrote yourself are never touched.
- **History**: kept in `~/.voice-dictation/history.jsonl`, only on your Mac.
- **What's sent to the AI**: 400 characters on each side of the cursor, the selected text, the last ~1,500 characters visible in the window, the app, the window title and the URL.

| Provider | Default model | Speed (measured median) | Cost |
|---|---|---|---|
| DeepSeek | `deepseek-flash` | 0.75 s | About US$0.00004 per passage (doubled during DeepSeek's peak hours) |
| Claude | `claude-haiku-5-5` | 0.85 s | About US$0.00004 per passage |
| OpenAI | `gpt-6-luna` | 1.1 s | About US$0.00003 per passage |

Dictating an hour a day, AI cleanup costs less than US$1 a month.

## Auto-focus and voice commands (layer 3)

- **Auto-focus**: when the cursor isn't in a text field, the decision maker picks one of the fields in the window (search boxes and the address bar included), focuses it and writes there.
- **Voice commands** (needs AI cleanup): say "open the TSMC stock page", "open settings", "tell BU hello on LINE" or "open YouTube", and it operates your apps (the same agent as CubeLV's voice commands):
  - At each step it reads the whole screen of the frontmost app (the Accessibility tree: dialogs, toolbars and lists level by level, with a number and a state for everything you can use), and the AI picks one tool: click, right-click, type, press a key (shortcuts like cmd+l too), scroll, pick from a pop-up menu, use the menu bar, switch apps or open a URL. Nothing is hard-coded, such as "search first"; the AI decides from the screen.
  - It keeps going until the screen shows what you asked for, or the AI has tried a few ways and can't; it stops after 15 steps, when it goes back and forth between two steps, or repeats the same step three times. "Pause listening" also stops it. The bubble shows each step and the name of what it clicked.
  - When the cursor is in a text field (for example Claude's prompt box), Jev looks at what's on screen to decide: if it's clearly an instruction to operate the screen, or it names something on screen, it's treated as a command; something like "switch to another branch and run the tests again", meant for the AI, is typed as usual. For short, ambiguous phrases, start with "command, …" and it's always treated as a command.
- **Message someone**: say "tell BU hello" or "tell Mom I'll be late"; the same agent handles it, with the message in the goal, and the AI finds the conversation on screen and writes the message.
- **Apps it can't read** (LINE, for example: the chat list is rows without names): it captures the frontmost window and reads the text and positions with macOS's built-in text recognition (on your Mac; the image is never saved or sent); rows without names are named by the text inside them, and the rest of the text becomes positions it can click. This needs one more permission, Screen Recording; apps it can read are never captured.
- **Decision maker**:
  - With a Jev key (`jev`), Jev decides, about 0.2 s per decision.
  - Jev decides whether what you said is a command and which text field to write into; without Jev, your AI provider does. Each step of a voice command is decided by your AI provider.

## Transcription engines

| Engine | Accuracy | Cost | Where your audio goes |
|---|---|---|---|
| `openai` (`gpt-transcribe`, default) | Most accurate, uses your vocabulary | US$0.0045 a minute; an hour a day is about US$7.4 a month | OpenAI |
| `openai` (`gpt-live-transcribe`) | Slightly worse | US$0.017 a minute | OpenAI |
| `local` (SenseVoice-Small) | Good Chinese, weaker English, ignores vocabulary | Free | Never leaves your Mac |
| `cubelv` (Sign in with CubeLV) | Same as `gpt-live-transcribe` | Uses your CubeLV account's credits | CubeLV, then OpenAI |
| `parallelsandbox` | Same as `gpt-live-transcribe` | Depends on your ParallelSandbox plan | ParallelSandbox, then OpenAI |

Only segments recognized as speech are sent; nothing is sent while it's quiet. Costs include the ~1.25 s of padding around each sentence. To switch engines pick one under "Transcription" in the menu, run `./install.sh <engine>`, or edit the config file; changes apply within a few seconds of saving.

## Set up your own key

No config file to edit and no Terminal needed:

- **Set up**: choose "Set up your own key…" in the menu, pick a provider (OpenAI: transcription and AI cleanup share one key; DeepSeek, Claude: AI cleanup; TypeSafe Jev: voice-command decisions, optional), paste your key and choose Test and Save.
- **Tested before it's saved**: it makes one real call, the same check as `ai-check.mjs`. If it works, the key is saved and you're told you're all set; if not, you're told why (wrong key, out of balance, can't connect) and nothing is saved.
- **Switches over for you**: DeepSeek and Claude switch AI cleanup to that provider; OpenAI switches AI cleanup only if you don't already have a working provider, and switches transcription only if you tick "Also use OpenAI for transcription", otherwise transcription stays as it is (on-device by default); Jev is used as soon as it has a key. Picking a provider without a key from the "AI cleanup" or "Transcription" submenu opens the same dialog.
- **Where it's kept**: the macOS Keychain (Keychain Access shows entries such as "JarvisVoice OpenAI key"), never the config file. Set it again to replace the key, or choose Remove Saved Key in the same dialog.
- **How it relates to the config file**: a key saved from the menu comes first, then the config file's `apiKey` / `ai.keys`, `apiKeyFile` / `ai.keyFiles`, `ai.keyCommands` and environment variables. All of those still work as before; remove the menu key and the one in your config file is used again.
- **From Terminal**: `node ~/jarvis-voice/bin/set-key.mjs set deepseek` (the key isn't shown as you paste; `set openai --engine` also switches transcription to OpenAI).

## Sign in with CubeLV

If you'd rather not get and look after your own keys, you can use a CubeLV account:

- **Sign in**: choose "Sign in with CubeLV…" in the menu; your browser opens CubeLV, and you choose Allow (or run `node ~/jarvis-voice/bin/cubelv-login.mjs` in Terminal). Transcription and AI cleanup then switch to CubeLV; to use it for only one of them, switch the other back to on-device or your own key from the "Transcription" or "AI cleanup" submenu.
- **Cost**: transcription per recorded minute, AI cleanup and voice-command decisions by usage, charged to your CubeLV credits. Every plan can use it. When you run out, the menu and the bubble next to your cursor say so; top up in CubeLV, or switch back to on-device or your own key.
- **Access**: this sign-in only works for voice input (transcription and AI cleanup). It can't see or change your notes or any other data in CubeLV. It's stored in the macOS Keychain, not in the config file, and you can revoke it any time under Connected AI tools in CubeLV's settings.
- **Sign out**: choose "Sign out of CubeLV"; transcription and AI cleanup go back to what you had before.
- **What's sent**: the same as with your own keys (audio and the AI cleanup context), only to CubeLV, which passes it to the model.

## Config file

`~/.voice-dictation/config.json`; anything you leave out uses the default:

```json
{
  "engine": "openai",
  "output": "traditional",
  "replacements": { "部屬": "部署" },
  "openai": {
    "apiKeyFile": "~/secrets/openai.env",
    "model": "gpt-transcribe",
    "languages": ["zh-tw", "en"],
    "prompt": "A Taiwanese engineer dictating in Chinese mixed with English about software development and operations."
  }
}
```

| Field | Meaning |
|---|---|
| `engine` | `openai`, `local`, `cubelv`, `parallelsandbox` |
| `apps` | Only listen in these apps (bundle ids); default `["*"]`, all apps |
| `excludeApps` | Don't listen while these apps are frontmost; defaults to meeting and calling apps |
| `output` | `traditional` (Taiwan Traditional Chinese), `simplified`, `original` |
| `replacements` | Fixed replacements for spellings that are still wrong after testing |
| `openai.model` | `gpt-transcribe` (default, whole sentence at once) or `gpt-live-transcribe` (real-time) |
| `openai.apiKey` / `openai.apiKeyFile` | The key itself, or a file containing it (just the key, or a .env with `OPENAI_API_KEY=`); otherwise the `OPENAI_API_KEY` environment variable. A key saved under "Set up your own key…" (Keychain) comes before all of these |
| `openai.languages` | Expected languages, e.g. `["zh-tw", "en"]` |
| `openai.prompt` | A sentence or two describing the setting; don't put your vocabulary here |
| `openai.vocabularyFile` | Vocabulary file, default `~/.voice-dictation/vocabulary.txt`, one term per line |
| `local.language` | `auto`, or `zh`, `en`, `yue`, `ja`, `ko` |
| `ai.enabled` / `ai.provider` | AI cleanup on/off (default on); `deepseek`, `openai`, `claude`, `cubelv` (Sign in with CubeLV). If unset, whichever provider you already have a key for. Also switchable from the menu |
| `ai.keys` / `ai.keyFiles` / `ai.keyCommands` | Each provider's key, a file with the key, or a command that prints it (e.g. `aws ssm get-parameter ...`, so the key never touches disk). Otherwise the `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` environment variables; OpenAI reuses the `openai` key. A key saved under "Set up your own key…" (Keychain) comes before all of these |
| `ai.models` | Use a different model, e.g. `{ "openai": "gpt-4.1-mini" }` |
| `ai.segmentPauseMs` | How long a pause ends a passage, default 1800 (only waited out in full when early cleanup is off) |
| `speed.earlyTranscribeMs` | Send the sentence for transcription after this much silence, default 400 (discarded if you keep talking); 0 turns it off |
| `speed.draft` | Put the raw text in the field as soon as it's back and swap in the cleaned-up text when it's ready (not if you've already sent or edited it), on by default; off waits for cleanup before writing anything |
| `speed.live` | Type the on-device preview into the field while you talk (needs `speed.draft` and `speed.preview`), on by default; off waits for the end of each sentence |
| `speed.pasteAfterMs` | Start cleanup as soon as the text is back, and paste (or swap out the raw text) if you've been quiet this long when it's ready, default 1200; 0 waits for `ai.segmentPauseMs` |
| `speed.hedge` | How many copies of each transcription and cleanup request to send at once, using whichever answers first, default 2 (cost scales with it) |
| `speed.bubble` / `speed.preview` | The bubble next to the cursor, and the live preview while you talk (on-device SenseVoice); both on by default |
| `ai.styles` | Tone per app (bundle id) or website (domain), e.g. `{ "com.tinyspeck.slackmacgap": "casual and short" }` |
| `ai.screenChars` | How many characters of on-screen text go to the AI, default 1500 |
| `ai.history` / `ai.learn` | Local history, learning from your corrections; both on by default |
| `ai.autoVocabulary` | Automatic vocabulary updates: `{ "enabled": true, "max": 250, "maxAuto": 80, "minSightings": 3 }` |
| `autoFocus` | Find a text field when the cursor isn't in one (default on) |
| `commands` | Voice commands (default on) |
| `jev.apiKey` / `jev.apiKeyFile` / `jev.apiKeyCommand` | Your TypeSafe key (or the `TYPESAFE_API_KEY` environment variable); a key saved under "Set up your own key…" comes first |
| `cubelv.apiUrl` | Which CubeLV to sign in to, default `https://app-api.cubelv.com`; the sign-in itself lives in the Keychain, not in the config file |

## Troubleshooting

- **No menu bar icon**: open `~/Applications/JarvisVoice.app`. On macOS 26, check System Settings → Menu Bar to make sure it's allowed.
- **Exclamation mark icon**: open the menu; the first line says why.
- **AI cleanup does nothing, or the menu says "(no key)" or "(not signed in)"**: paste the key again under "Set up your own key…" in the menu (it tells you why if it doesn't work), or run `node ~/jarvis-voice/bin/ai-check.mjs`; it tells you what's missing.
- **Errors after signing in with CubeLV**: "Out of CubeLV credits" means top up in CubeLV; "Your CubeLV sign-in has expired" means choose "Sign in with CubeLV…" again. You can also switch back to on-device or your own key from the menu.
- **Nothing gets pasted**: make sure the cursor is in a text field, then make sure "JarvisVoice" is turned on under Accessibility.
- **Detailed log**: `~/.voice-dictation/listen.log`.
- **Reinstall or update**: `git pull && ./install.sh`. If the app shell (`app/main.js`) and packaging haven't changed, it isn't rebuilt and you keep your permissions. If your keychain has an Apple developer certificate (Developer ID Application or Apple Development), the app is signed with it and keeps its permissions across rebuilds; otherwise it's signed ad hoc, macOS asks for the microphone again after a rebuild, and under Accessibility you need to select "JarvisVoice", remove it with "−", then reopen JarvisVoice and turn it on (just toggling it off and on doesn't work: the switch looks on but still points at the old build).

## How it works

- `app/main.js`: the menu bar app shell, packaged into `JarvisVoice.app` with macOS's built-in `osacompile` (no Xcode). Microphone and Accessibility permissions belong to it.
- `app/ui.js`: the menu bar UI and the code that starts the background process. The shell loads it at launch, so changing it doesn't require rebuilding the app or re-granting permissions; quit from the menu and reopen to apply.
- `bin/listen.mjs`: the background process. It watches which app is frontmost, records with ffmpeg, splits sentences locally and hands them to the transcription engine; with AI cleanup on, it groups them into passages for the AI, then writes into the text field or runs the command.
- `bin/engines/`: `batch.mjs` (OpenAI transcription), `realtime.mjs` (real-time transcription via OpenAI, CubeLV or ParallelSandbox), `local.mjs` (SenseVoice via sherpa-onnx).
- `bin/own-keys.mjs`, `bin/set-key.mjs`: "Set up your own key…" in the menu (test before saving, keys kept in the Keychain, switching transcription and AI cleanup).
- `bin/cubelv.mjs`, `bin/cubelv-login.mjs`: Sign in with CubeLV (browser authorization, tokens kept in the Keychain and refreshed automatically, CubeLV transcription and AI cleanup).
- `bin/ax-agent.js`: the long-running Accessibility helper (JXA). Reads context and on-screen text, finds and focuses text fields, pastes (save clipboard → Cmd+V → restore, only to the frontmost app), selects what it just pasted to replace it, and lists and operates on-screen controls.
- `core/`: the shared core, one copy used by this app, CubeLV and ParallelSandbox (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)); other projects mount this repo as a git submodule and import `core/index.mjs` directly (never copy it).
- `bin/editor.mjs`: AI cleanup. `bin/ai-check.mjs`: checks that AI cleanup and the decision maker are set up. `bin/decide.mjs`: layer 3 decisions (Jev). `bin/agent-screen.mjs`: voice commands (reads the frontmost app's screen for the shared agent and carries out its steps). `bin/targeter.mjs`: rules for picking a text field. `bin/learn.mjs`: learning from your corrections. `bin/vocab-auto.mjs`: automatic vocabulary updates and the cap.
- `bin/vocab-test.mjs`: vocabulary test (see [AI_SETUP.md](AI_SETUP.md)).
- `site/`: the jarvis-voice.com website, published to GitHub Pages by GitHub Actions on every push to main.

## Development

```bash
npm install
npm test                                  # never sends keystrokes or takes focus
VOICE_DICTATION_FOCUS_TESTS=1 npm test    # also checks real pasting and reverting with the test window frontmost (takes focus for ~2 s)
TYPESAFE_API_KEY=... npm test             # also lets the real Jev drive the stock-app test window
VOICE_DICTATION_REAL_AI=1 npm test        # also runs AI cleanup against all three real providers (greetings, one-word replies and swearing kept; filler and self-corrections still cleaned), using the keys in your config
VOICE_DICTATION_E2E=1 npm test            # also runs real speech end to end: say speaks sentences -> transcription -> AI cleanup -> pasted into the test window, then reads the window back (calls the cloud, takes focus; waits for 3 s of no keyboard or mouse before each sentence)
```

## Uninstall

```bash
./uninstall.sh
```

Your config, vocabulary and models stay in `~/.voice-dictation`; delete it yourself if you don't need them.

## License

The code is MIT licensed. The local model is downloaded by `install.sh` from [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and isn't part of this repo; see the [FunASR model license](https://github.com/modelscope/FunASR?tab=readme-ov-file#license).
