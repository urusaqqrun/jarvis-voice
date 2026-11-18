---
name: jarvis-voice
description: Install and set up JarvisVoice, a free, open-source macOS menu bar app for always-on voice typing (talk and the words go into the app you're using, including Claude Code, ChatGPT and the browser). Use when the user wants to dictate instead of type on a Mac, wants voice input without pressing a button, or wants JarvisVoice's vocabulary, AI cleanup or voice commands configured.
---

# JarvisVoice

JarvisVoice listens while it runs and types what the user says into the text field where the cursor is, in any app. Apple Silicon Mac, macOS 14 or later. MIT licensed: on-device transcription is free; AI cleanup uses the user's own OpenAI, DeepSeek or Claude key.

## 1. Install it (skip if `/Applications/JarvisVoice.app` exists)

- With Homebrew: `brew install --cask urusaqqrun/tap/jarvis-voice`
- Without Homebrew: download https://github.com/urusaqqrun/jarvis-voice/releases/latest/download/JarvisVoice.dmg, open it and drag JarvisVoice into Applications.

Then run `open -a JarvisVoice`. A setup window asks for two permissions (Microphone and Accessibility), downloads the on-device model and has the user try a sentence. Only the user can grant permissions: tell them what to click, then wait.

## 2. Set it up

Read https://github.com/urusaqqrun/jarvis-voice/blob/main/AI_SETUP.md and follow it: collect the user's own terms into the vocabulary file, test them, and ask whether they want AI cleanup, auto-focus and voice commands. In the downloaded app the scripts and Node are inside the app, so replace `node ~/jarvis-voice/bin/…` with `/Applications/JarvisVoice.app/Contents/Resources/node /Applications/JarvisVoice.app/Contents/Resources/app/bin/…`.

Never ask the user to paste an API key into the chat: they paste it under "Set up your own key…" in the JarvisVoice menu.

Talk to the user in their own language.
