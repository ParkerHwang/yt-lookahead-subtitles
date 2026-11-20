#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_PATH="${ROOT_DIR}/models/ggml-large-v3-turbo-q5_0.bin"

if ! command -v whisper-server >/dev/null 2>&1; then
  echo "whisper-server not found. Run: bash scripts/setup-asr.sh" >&2
  exit 1
fi

if [ ! -f "${MODEL_PATH}" ]; then
  echo "Model file not found at ${MODEL_PATH}. Run: bash scripts/setup-asr.sh" >&2
  exit 1
fi

if companion_status="$(curl -fs --max-time 2 "http://127.0.0.1:${COMPANION_PORT:-17864}/health")"; then
  if ! node -e "try { const h=JSON.parse(process.argv[1]); process.exit(h.application === 'lookahead-subtitles' && h.pairingRequired ? 0 : 1); } catch { process.exit(1); }" "${companion_status}"; then
    echo "다른 프로그램이나 이전 보조 앱이 이 포트를 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 실행하세요." >&2
    exit 1
  fi
  echo "보조 앱이 이미 실행 중입니다. 확장 프로그램에 입력할 이 컴퓨터의 연결 코드입니다."
  node --input-type=module -e "import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; const dir=process.env.YT_SUB_CONFIG_DIR || path.join(os.homedir(),'.config','lookahead-subtitles'); console.log(JSON.parse(fs.readFileSync(path.join(dir,'pairing.json'),'utf8')).pairingCode)"
  exit 0
fi

WHISPER_PID=""
cleanup() {
  if [ -n "${WHISPER_PID}" ] && kill -0 "${WHISPER_PID}" 2>/dev/null; then
    kill "${WHISPER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if ! curl -sf http://127.0.0.1:8178/ >/dev/null 2>&1; then
  echo "Starting whisper-server on 127.0.0.1:8178..."
  whisper-server -m "${MODEL_PATH}" -l auto -sns --host 127.0.0.1 --port 8178 &
  WHISPER_PID=$!
  for _ in $(seq 1 40); do
    if curl -sf http://127.0.0.1:8178/ >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
else
  echo "whisper-server already listening on 127.0.0.1:8178"
fi

echo "Starting companion server on 127.0.0.1:${COMPANION_PORT:-17864}..."
node "${ROOT_DIR}/companion/server.mjs"
