# Privacy policy

Effective date 2026-11-20

Lookahead Subtitles for YouTube is maintained by ParkerHwang. This policy covers the published extension and the local companion distributed in this repository. A modified fork or a separately configured speech service can have different data handling.

## Information used for subtitles

The extension reads the current YouTube video identifier, playback time, selected audio/caption metadata and available subtitle text. It uses those values to select a source, preserve timing, recover after a seek and display translated subtitles.

During a user-enabled subtitle-source lookup, the extension observes requests to YouTube’s `api/timedtext` endpoint for that tab and video. It holds the caption request URL, language, track type and capture time in memory for up to eight seconds, or until that worker stops, the tab navigates or processing is disabled. These URLs can include YouTube-issued signed query parameters. The references let the extension load the track requested by the normal player.

When you enable processing for a video without usable captions, the extension processes the tab’s audio and rendered frames. Audio chunks are sent to the companion on `127.0.0.1`, then to the local Whisper service. Frames and synchronized audio remain in a bounded in-memory playback buffer. The default speech service runs on your computer.

For translation, the companion sends source text, cue identifiers, available language/speaker hints, selected target language and a small amount of preceding/following dialogue to OpenAI. Preceding context can include earlier translated subtitles. Text can contain personal information spoken in the video. OpenAI’s response supplies the translated text and, when available, token-usage counts.

## ChatGPT account connection

Choosing **Continue with ChatGPT** opens OpenAI’s authorization service. When you authorize the app, the companion receives account/profile claims, an application registration identifier, granted permissions and OAuth access, refresh and ID tokens. The app uses these credentials to list models and make eligible translation requests under your selected plan. A persistent per-installation host identifier is included in this authorization flow.

The companion saves account names, email addresses, subject/registration identifiers, model choice and credentials in its local configuration directory. The default source-build location is `~/.config/lookahead-subtitles/`. The account store is encrypted with AES-256-GCM using a randomly generated key kept in the macOS login Keychain. Files also use owner-only access permissions. Host and pairing metadata are separate local files. Your operating-system account and Keychain controls remain part of protecting access. The popup reads a limited account status for display and account selection.

## Local storage and retention

| Information | Location and use | Retention |
| --- | --- | --- |
| Target language, preparation mode and companion pairing code | Chrome extension local storage | Until changed or cleared, or the extension is removed |
| Video identifiers and token-meter scope | Chrome extension session storage | Browser-session lifetime |
| Signed caption request URLs and request timing | Background memory during an active source lookup | Up to eight seconds, with earlier removal on navigation, disable or worker shutdown |
| GPT usage totals, request identifiers for deduplication and an account fingerprint | Chrome extension session storage | Session lifetime, with tab-scoped records removed on tab closure |
| Source and translated cues, language-detection samples and playback buffers | YouTube page/extension memory | Page/session lifetime, subject to internal bounded caches |
| OAuth credentials, basic profile, registration and model choice | Encrypted local companion account store | Until sign-out or local deletion, as described below |
| Per-install host identifier and pairing code | Separate local companion files | Until local deletion |
| Downloaded speech model | Repository’s `models/` folder | Until the user removes the model |

Transcript processing is performed in memory by the companion. User-run development scripts can create local diagnostic files containing transcripts, timings and screenshots. Terminal output from the separately installed speech tool can also include operational or transcription details. Review such files before sharing them.

## Services receiving data

- **YouTube/Google** receives normal page, media and caption requests made while using its player. Those services apply their own policies.
- **OpenAI** receives sign-in/authorization traffic and text translation requests. Requests use HTTPS and set `store: false` on the Responses API. OpenAI’s applicable terms and data policies govern its handling and retention. This setting alone does not establish a universal retention period.
- **The local companion and Whisper service** receive audio and subtitle data on loopback addresses. Local HTTP is used between processes on the same computer.
- **Homebrew and the model distribution host** receive ordinary software/model-download requests when you run the setup script.

The distributed production code limits data handling to subtitle functionality and user-requested support. It has no developer-operated collection endpoint, advertising system or analytics SDK. The developer receives information you choose to submit through GitHub or another support channel. GitHub handles those submissions under its own policies.

## Choices, access and deletion

Click the player’s subtitle button to stop active processing. You can change the target language or preparation mode in the popup. Closing the page releases its playback state. Closing a browser tab removes its token-meter scope; ending the browser session clears session storage.

Use **Sign out** in the popup to clear that account’s local access, refresh and ID tokens. The companion then attempts to revoke the refresh credential through OpenAI. Remote revocation can fail if the network or provider is unavailable. Registration and profile details are retained for returning sign-in. Manage the app connection and plan limits in your ChatGPT account settings.

To remove all local companion account data, sign out, stop the companion, and remove its configuration directory. This also removes its host identifier, pairing code and compiled Keychain helper. Its encryption-key item can be removed separately in macOS Keychain Access under the label **Lookahead Subtitles credential encryption**. Clear extension data or uninstall the extension to remove its stored preferences and pairing value. Removing the downloaded model is a separate local-file action. Changes to local files do not erase data already handled by external services.

## Contact and changes

Questions can be submitted through the [project issue tracker](https://github.com/ParkerHwang/yt-lookahead-subtitles/issues). Keep secrets and private content out of public issues. Policy updates will be dated in this file and should be reviewed alongside the extension version.

[OpenAI privacy information](https://openai.com/policies/privacy-policy/) · [Google privacy information](https://policies.google.com/privacy) · [GitHub privacy information](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
