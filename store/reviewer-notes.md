# Reviewer setup and privacy worksheet

These are prepared submission notes. The publisher must review the final package, live dashboard fields, privacy declarations and attestations.

## Single purpose

Provide translated subtitles on desktop YouTube watch pages using available caption tracks or local speech recognition, with the viewer’s selected output language.

## External prerequisite and test setup

The extension connects to a separate local companion on `127.0.0.1:17864`. Captionless videos also require a local Whisper service on `127.0.0.1:8178`. The supplied setup path is tested on macOS with Apple Silicon, Homebrew, Node.js 22 or later and Xcode Command Line Tools. A small Keychain helper is compiled on first account storage; macOS can prompt for Keychain access. The speech model is downloaded separately.

1. Clone the public repository and run `npm run setup:asr`, then `npm start`.
2. Install the uploaded extension package and enter the companion terminal’s pairing code in its popup.
3. Choose **Continue with ChatGPT** and complete OpenAI’s authorization with a supported account that can grant plan usage. Translation requests consume the reviewer’s authorized plan allowance.
4. Open a public YouTube video, select a target language in the popup and click the player’s language subtitle button.
5. For an existing-caption test, use a video with a standard creator caption track in a language different from the desired output. The extension should use the caption source and its timing.
6. For a captionless test, expect initial language detection and synchronized audio/video preparation. The 24-second option can wait longer than the 12-second option.

A packaged test uses synthetic media and mock translation responses through `npm run test:e2e`. It exercises rendering and controls without a connected ChatGPT account. This is a development check; the normal product uses the authorized provider connection for actual translation.

## Store identity before a functional submission

The source manifest carries a development public key that fixes its unpacked ID. The local companion permits that development origin. Chrome Web Store assigns an item identity after upload. For the store build, set `YT_SUB_STORE_EXTENSION_ID` to the exact assigned 32-character extension ID when starting the companion. This setting accepts lowercase letters a–p. Confirm the store build’s pairing, sign-in and translation from a clean installation before submitting it for review. Update the installation instructions with the actual store item link once assigned.

The ZIP contains extension runtime assets. The companion, source tests and speech model stay outside the ZIP. The extension JavaScript and worklet are bundled files.

## Permission explanations

| Manifest permission | User-facing reason |
| --- | --- |
| `storage` | Save language/preparation preferences and pairing value, and keep token-meter state during the browser session. Caption request references stay briefly in memory during an active lookup. |
| `activeTab` | Inspect and communicate with the current YouTube tab from the popup and support user-initiated tab capture. |
| `tabCapture` | Supply the fallback tab-audio capture path when enabled by a user action, for local speech recognition and synchronized playback. |
| `offscreen` | Host the extension’s audio capture/playback fallback outside the service worker. |
| `webRequest` | Observe YouTube caption endpoint requests so the requested caption track can be loaded with its timestamps. An active tab/video-scoped lookup can keep signed caption request references in memory for up to eight seconds. |
| `https://www.youtube.com/*` | Read the watch page/player and caption source, render the subtitle control/overlay and process the enabled video. |
| `http://127.0.0.1/*` | Reach the user-installed local companion. The production destination is fixed to loopback port 17864. |

## Data-use disclosure worksheet

Based on the current source, the following dashboard data categories need publisher review. Chrome’s user-data rules cover local processing as well as external transmission.

| Data category | Current handling to disclose |
| --- | --- |
| Personally identifiable information | OpenAI profile claims such as account name and email reach the local companion for account selection. |
| Authentication information | OAuth tokens are stored in the local companion; the extension keeps a local pairing credential. |
| Web history / browsing activity | Current YouTube video IDs, playback position and limited caption endpoint URLs are used for the subtitle feature and temporary usage scoping. |
| Website content | Subtitle text, surrounding dialogue, video audio and rendered frames are processed. Text/context go to OpenAI. Default audio recognition and delayed frames stay local. |
| User activity | Subtitle controls, language preference and playback state are processed to operate the requested feature. The published code has no analytics SDK or developer collection endpoint. |

If the current dashboard offers additional audiovisual categories, disclose the local tab-audio/frame handling there. Speech or source subtitles can themselves contain personal information. Review any category interpretation against the actual dashboard and privacy policy. The publisher should make the final limited-use certifications.

## Security and consent checks before submission

The companion validates the extension origin, Host header and local pairing value. OAuth uses PKCE, state and ID-token validation. The local account store uses AES-256-GCM encryption with a random key in the macOS login Keychain and owner-only file permissions. Host/pairing metadata is stored separately. The publisher should review the final companion build and Chrome Web Store secure-handling requirements before making compliance declarations.

The player starts translation through a trusted user action after account checks. The popup shows account/plan permission status. The policy must remain consistent with the product’s in-interface disclosure, including text/context sent to OpenAI and local audio handling. Inspect the first-run disclosure requirements for the final release.

## Privacy and support URLs

- Privacy — https://github.com/ParkerHwang/yt-lookahead-subtitles/blob/main/PRIVACY.md
- Support — https://github.com/ParkerHwang/yt-lookahead-subtitles/issues

Relevant official instructions are [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), and [publishing](https://developer.chrome.com/docs/webstore/publish).
