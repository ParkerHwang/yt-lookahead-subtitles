#!/bin/bash
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
echo '이 창을 열어 두세요. Chrome 확장 프로그램에서 아래 연결 코드를 입력하고 Continue with ChatGPT를 누르세요.'
exec bash scripts/start-companion.sh
