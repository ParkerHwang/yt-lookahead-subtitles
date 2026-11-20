# Chrome Web Store listing draft

Publisher should review these fields against the final uploaded package and current dashboard before submission.

## Name

Lookahead Subtitles for YouTube

## Short description

Translate YouTube subtitles into your chosen language with local speech recognition and your eligible ChatGPT plan. Setup required.

## Detailed description

Watch YouTube dialogue with subtitles in a language you choose.

Lookahead Subtitles for YouTube uses available subtitle tracks first. A creator-uploaded English track, for example, can supply the text and timing for Spanish output. When a video has no usable captions, the local companion uses Whisper to recognize speech on your computer and prepares translated subtitles ahead of the delayed viewing position.

Features include 33 common subtitle-language choices, custom language codes, approximately 12- or 24-second preparation targets, pause/seek handling, and confirmed GPT input/output token totals. Actual preparation length depends on the source, playback speed and computer performance.

SETUP REQUIRED

This release requires desktop Chrome plus a separately installed local companion on macOS. The companion requires Node.js 22 or later, Apple’s Xcode Command Line Tools, Whisper.cpp and a downloaded speech model of approximately 550 MB. Setup instructions are provided in the linked GitHub repository.

Translation requires an eligible ChatGPT account and explicit permission for this app to use its plan. Translation requests consume your plan allowance. Plan availability and limits are controlled by OpenAI. The extension’s token display shows reported request usage, while your ChatGPT settings control the plan allowance.

For captionless videos, initial preparation delays the viewed picture and sound together. Overlapping voices, names, jokes, music and short reactions can cause recognition or translation errors. Source captions determine available speaker information. Platform support beyond the tested macOS desktop setup requires further validation.

Source and setup
https://github.com/ParkerHwang/yt-lookahead-subtitles

Privacy policy
https://github.com/ParkerHwang/yt-lookahead-subtitles/blob/main/PRIVACY.md

Independent open-source project maintained by ParkerHwang. YouTube and ChatGPT are trademarks of their respective owners.

## Korean description

YouTube 영상을 선택한 언어의 자막으로 시청할 수 있습니다. 제작자가 올린 원본 자막이 있으면 문장과 시각을 사용해 번역합니다. 사용할 자막이 없는 영상은 로컬 Whisper가 음성을 인식하고, 화면과 소리를 함께 잠시 늦춰 다음 대사의 번역을 준비합니다.

33개 언어 선택과 다른 언어 코드 입력, 약 12초·24초 준비 목표, 탐색·일시정지 처리와 실제 GPT 토큰 사용량 표시를 지원합니다. 여러 사람이 겹쳐 말하거나 고유명사·짧은 반응이 포함된 장면에서는 오류가 날 수 있습니다.

설치 전에 확인해 주세요. 이 버전은 macOS의 별도 로컬 보조 앱, Node.js 22 이상, Xcode Command Line Tools, Whisper.cpp와 약 550MB의 음성 모델 설치가 필요합니다. 번역에는 이 앱의 사용을 허용한 지원 대상 ChatGPT 계정과 해당 계정의 사용량이 필요합니다. 사용 방법은 GitHub 저장소에 있습니다.

## Suggested category and language

Accessibility is a possible category because the single purpose is translated subtitle access. Productivity may also be available in the current dashboard. Publisher should choose the available category that best describes the final listing. The current popup labels are Korean; select the store listing’s default language to match the submitted description.

## Support and links

- Homepage — https://github.com/ParkerHwang/yt-lookahead-subtitles
- Support — https://github.com/ParkerHwang/yt-lookahead-subtitles/issues
- Privacy — https://github.com/ParkerHwang/yt-lookahead-subtitles/blob/main/PRIVACY.md

Use original demonstration assets from `store/assets/`. A screenshot must correspond to the actual extension interface and identify any sample transcript/token values shown.
