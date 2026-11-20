# Lookahead Subtitles for YouTube

Translate YouTube dialogue into a selected subtitle language while watching in desktop Chrome. The extension uses available subtitle tracks first. For videos without usable captions, a local Whisper service transcribes audio and the player holds a short synchronized audio/video buffer while translations are prepared.

This is an early open-source release tested on macOS with Apple Silicon. It requires a separately running local companion and an eligible ChatGPT account that grants this app permission to use its plan. Translation requests consume that account’s allowance. Availability depends on OpenAI’s current plan and integration rules.

## Features

- Translate creator-uploaded subtitles when the video lacks the language you want.
- Select from 33 subtitle languages or enter a supported language code.
- Detect a captionless video’s spoken language locally, using several seconds of startup audio.
- Prepare subtitles ahead of viewing with approximately 12-second or 24-second targets at normal speed.
- Show the actual prepared video/subtitle intervals and confirmed GPT input/output token usage.
- Preserve source timing and available speaker labels, with pause, seek and target-language changes.

## Setup on macOS

Install desktop Chrome, Node.js 22 or later, Homebrew and Apple’s Xcode Command Line Tools. The companion compiles a small Keychain helper on first account storage. The setup script installs `whisper-cpp` through Homebrew and downloads the multilingual Whisper model from its upstream distribution. Allow approximately 550 MB for the model, plus the tools and temporary playback data.

```bash
git clone https://github.com/ParkerHwang/yt-lookahead-subtitles.git
cd yt-lookahead-subtitles
npm run setup:asr
npm start
```

Keep the companion terminal open. It starts the local service on `127.0.0.1:17864` and uses Whisper on `127.0.0.1:8178`. The first setup downloads the model into `models/`; the Git repository contains the source and setup script.

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository’s `extension` folder.
3. Open the extension popup and enter the pairing code shown in the companion terminal.
4. Select **Continue with ChatGPT**, choose your account on OpenAI’s authorization page and grant plan usage permission. macOS may ask for access to the companion’s Keychain encryption item.
5. Open or refresh a YouTube watch page. Choose **보고 싶은 자막 언어** in the popup, then click the corresponding subtitle button in the player.

The popup currently uses Korean labels. Its language control chooses the subtitle output. The player button displays the selected language. Click that button again to stop subtitle processing. After initial setup, `npm start` or `자막 시작.command` starts the companion.

## Caption sources and playback

An available creator subtitle track supplies text and timestamps directly. If it already matches the selected target language, it can be displayed directly. Otherwise, the companion sends small text batches and nearby dialogue context to OpenAI for translation.

Captionless playback sends audio to the local Whisper process. Initial language detection needs several seconds of audio. The extension delays the viewed picture and sound together so upcoming dialogue can be recognized and translated. Longer preparation can increase startup waiting. YouTube controls its downloaded-media buffer, and the extension’s preparation targets depend on processing speed.

Simultaneous voices, background audio, names, jokes and short reactions can produce recognition or translation errors. The extension uses speaker labels when supplied by source captions. A mixed audio recording can lose overlapping speakers. Native YouTube controls may show the source playhead ahead of the delayed view. Live streams, DRM-protected media, mobile browsers and platforms other than the tested macOS setup require further validation.

The token meter shows usage returned by translation responses for the current tab, video and connected account. Cached playback adds no new request. Interrupted requests or responses without usage remain visibly unconfirmed. Token counts and the remaining ChatGPT plan allowance are different measurements.

## Account and privacy controls

The popup supports adding another ChatGPT account, selecting a saved account and signing it out. Sign-out clears local access, refresh and ID tokens, then attempts remote revocation. Saved registration/profile information remains available for returning sign-in. OpenAI account settings provide connection and allowance controls.

The companion encrypts the account store with AES-256-GCM. Its encryption key is kept in the macOS login Keychain; the encrypted store is in `~/.config/lookahead-subtitles/`. Extension storage holds preferences and the pairing code. The extension temporarily holds caption request references in memory during an active source lookup. Browser-session storage holds video-scoped token-meter records. Read the complete data flow, retention and deletion controls in [PRIVACY.md](PRIVACY.md).

## Development

The production extension is in `extension/`. The local Node companion is in `companion/`. Runtime code uses Node’s built-in modules.

```bash
npm test
npm run test:e2e
```

The unit suite uses isolated fixtures. The browser suite requires desktop Chrome on macOS, creates a separate temporary profile and uses synthetic media and mock translation responses. `CHROME_BIN` can select another installed compatible Chrome executable. Test results distinguish actual media/recognition from simulated translations.

The explicit live-check scripts are maintainer diagnostics. They require the running paired companion, a connected account, supplied prior usage and a bounded test case. They can consume ChatGPT plan usage when run with `--run`. Keep their temporary profiles and reports private because diagnostics can contain transcripts and account-related context.

For a store submission, package the `extension/` directory only. The companion, Whisper executable and model are installed separately. Follow [store/reviewer-notes.md](store/reviewer-notes.md) for the store-assigned extension identity and review setup.

## Support

Report reproducible bugs through [GitHub Issues](https://github.com/ParkerHwang/yt-lookahead-subtitles/issues). Include Chrome/macOS versions, a public video link if appropriate, and the visible error. Remove account details, OAuth callback URLs, pairing codes, signed caption URLs and private transcripts before posting.

[Privacy policy](PRIVACY.md) · [OpenAI account integration documentation](https://developers.openai.com/siwc) · [Whisper.cpp](https://github.com/ggml-org/whisper.cpp)

## License

[MIT License](LICENSE) · Copyright 2026 ParkerHwang.
