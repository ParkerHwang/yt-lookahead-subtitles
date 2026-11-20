#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${ROOT_DIR}/models"
MODEL_PATH="${MODELS_DIR}/ggml-large-v3-turbo-q5_0.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin"

mkdir -p "${MODELS_DIR}"

if ! command -v whisper-server >/dev/null 2>&1; then
  echo "Installing whisper-cpp via Homebrew..."
  HOMEBREW_NO_ASK=1 brew install whisper-cpp
else
  echo "whisper-server already installed: $(command -v whisper-server)"
fi

MODEL_SHA256="394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"
verify_model() {
  local hash
  hash="$(shasum -a 256 "$1")"
  [[ "${hash%% *}" == "${MODEL_SHA256}" ]]
}

if [[ -f "${MODEL_PATH}" ]]; then
  verify_model "${MODEL_PATH}" || { echo "Model checksum mismatch: ${MODEL_PATH}" >&2; exit 1; }
else
  model_tmp="$(mktemp "${MODELS_DIR}/model-download.XXXXXX")"
  trap 'rm -f "${model_tmp}"' EXIT
  curl -fL --retry 2 --progress-bar -o "${model_tmp}" "${MODEL_URL}"
  verify_model "${model_tmp}" || { echo "Downloaded model checksum mismatch." >&2; exit 1; }
  mv "${model_tmp}" "${MODEL_PATH}"
fi

echo "Setup complete."
echo "whisper-server: $(command -v whisper-server)"
echo "model: ${MODEL_PATH}"
