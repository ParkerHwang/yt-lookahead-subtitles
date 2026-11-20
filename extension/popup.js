import { companionRequest as apiFetch } from './companion-client.js';
import './subtitle-languages.js';
const { DEFAULT_TARGET_LANGUAGE, SUBTITLE_LANGUAGES, normalizeTargetLanguage, targetLanguageName } = globalThis.YTSubtitleLanguages;

const els = {
  companionPill: document.getElementById('companionPill'),
  errorCard: document.getElementById('errorCard'),
  errorTitle: document.getElementById('errorTitle'),
  errorDesc: document.getElementById('errorDesc'),
  signedOutCard: document.getElementById('signedOutCard'),
  signedInCard: document.getElementById('signedInCard'),
  offlineCard: document.getElementById('offlineCard'),
  continueBtn: document.getElementById('continueBtn'),
  continueBtnLabel: document.getElementById('continueBtnLabel'),
  accountEmail: document.getElementById('accountEmail'),
  accountMeta: document.getElementById('accountMeta'),
  signOutBtn: document.getElementById('signOutBtn'),
  planActiveBar: document.getElementById('planActiveBar'),
  planMissingBar: document.getElementById('planMissingBar'),
  enablePlanBtn: document.getElementById('enablePlanBtn'),
  modelPickerWrap: document.getElementById('modelPickerWrap'),
  modelSelect: document.getElementById('modelSelect'),
  accountSwitchWrap: document.getElementById('accountSwitchWrap'),
  accountSelect: document.getElementById('accountSelect'),
  addAccountBtn: document.getElementById('addAccountBtn'),
  retryBtn: document.getElementById('retryBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  asrStatus: document.getElementById('asrStatus'),
  welcomeModal: document.getElementById('welcomeModal'),
  gotItBtn: document.getElementById('gotItBtn'),
};

const pairCard = document.getElementById('pairCard');
const pairCode = document.getElementById('pairCode');

function showError(message) {
  els.errorCard.style.display = 'flex';
  els.errorTitle.textContent = '연결을 확인해 주세요';
  els.errorDesc.textContent = message;
}

pairCard.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = pairCode.value.trim();
  if (!value) return;
  await chrome.storage.local.set({ pairingCode: value });
  pairCode.value = '';
  await refreshStatus();
});

async function openAuth(options = {}) {
  try {
    const response = await apiFetch('/auth/start', { method: 'POST', body: options });
    if (!response.ok) throw new Error(response.data.message || '로그인을 시작할 수 없습니다.');
    const url = new URL(response.data.authUrl);
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') {
      throw new Error('로그인 주소를 확인할 수 없습니다.');
    }
    await chrome.tabs.create({ url: url.href });
  } catch (error) {
    showError(error.message);
  }
}

async function refreshStatus() {
  document.getElementById('newFromSignedOut').hidden = true;
  try {
    const [healthRes, authRes, storage] = await Promise.all([
      apiFetch('/health'),
      apiFetch('/api/auth/status', { method: 'POST', body: { includeModels: true } }),
      chrome.storage.local.get(['lastAuthError']),
    ]);

    if (!healthRes.ok) throw new Error('Companion unhealthy');

    els.offlineCard.style.display = 'none';
    const whisperOk = Boolean(healthRes.data?.whisper?.ok);
    els.asrStatus.textContent = whisperOk ? '받아쓰기 준비됨' : '받아쓰기 연결 필요';

    if (!authRes.ok) {
      els.signedOutCard.style.display = els.signedInCard.style.display = 'none';
      if (authRes.data.error === 'pairing_required') {
        els.companionPill.textContent = '연결 코드 필요';
        pairCard.style.display = 'flex';
        if ((await chrome.storage.local.get('pairingCode')).pairingCode) showError('보조 앱 창에서 연결 코드를 다시 확인해 주세요.');
        return;
      }
      throw new Error('Account status unavailable');
    }
    pairCard.style.display = 'none';
    const auth = authRes.data || {};
    const active = auth.activeAccount;
    const accounts = Array.isArray(auth.accounts) ? auth.accounts : [];

    // Surface recent usage-limit or policy errors cleanly
    const lastErr = storage.lastAuthError;
    if (lastErr && lastErr.code === 'subscription_sharing_usage_limit_exceeded') {
      els.errorCard.style.display = 'flex';
      els.errorTitle.textContent = '구독 공유 사용 한도에 도달했습니다';
      els.errorDesc.textContent =
        'ChatGPT 설정에서 이 앱에 배정한 사용량과 갱신 시점을 확인해 주세요.';
    } else if (lastErr && lastErr.code === 'subscription_sharing_user_not_eligible') {
      els.errorCard.style.display = 'flex';
      els.errorTitle.textContent = '계정의 구독을 확인해 주세요';
      els.errorDesc.textContent = lastErr.message || 'ChatGPT 설정에서 구독 사용 가능 여부를 확인해 주세요.';
    } else {
      els.errorCard.style.display = 'none';
    }

    if (!active || !active.signedIn) {
      els.companionPill.textContent = '로그인 필요';
      els.companionPill.className = 'pill warn';
      els.signedOutCard.style.display = 'flex';
      document.getElementById('newFromSignedOut').hidden = !accounts.length;
      els.signedInCard.style.display = 'none';

      if (accounts.length > 0) {
        // Show quick returning sign-in option for previously registered account
        const prev = accounts[0];
        els.continueBtnLabel.textContent = `Continue with ChatGPT (${prev.email || prev.label})`;
        els.continueBtn.onclick = () => openAuth({accountKey: prev.accountKey});
      } else {
        els.continueBtnLabel.textContent = 'Continue with ChatGPT';
        els.continueBtn.onclick = () => openAuth();
      }
      return;
    }

    els.signedOutCard.style.display = 'none';
    els.signedInCard.style.display = 'flex';
    els.accountEmail.textContent = active.email || active.label || active.subject;
    els.accountMeta.textContent = active.selectedModel || '번역 모델을 선택해 주세요';

    if (active.planUsageEnabled) {
      els.companionPill.textContent = '구독 연결됨';
      els.companionPill.className = 'pill ok';
      els.planActiveBar.style.display = 'flex';
      els.planMissingBar.style.display = 'none';

      if (!active.firstSignInConfirmed) {
        els.welcomeModal.classList.add('open');
      } else {
        els.welcomeModal.classList.remove('open');
      }

      const models = Array.isArray(auth.models) ? auth.models : [];
      if (models.length > 0) {
        els.modelPickerWrap.style.display = 'block';
        els.modelSelect.innerHTML = '';
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m.slug;
          opt.textContent = m.display_name || m.slug;
          if (m.slug === active.selectedModel) opt.selected = true;
          els.modelSelect.appendChild(opt);
        }
      } else {
        els.modelPickerWrap.style.display = 'none';
      }
    } else {
      els.companionPill.textContent = '구독 사용 허용 필요';
      els.companionPill.className = 'pill warn';
      els.planActiveBar.style.display = 'none';
      els.planMissingBar.style.display = 'flex';
      els.modelPickerWrap.style.display = 'none';
      els.enablePlanBtn.onclick = () =>
        openAuth({accountKey: active.accountKey, forceReconsent: true});
    }

    if (accounts.length > 0) {
      els.accountSwitchWrap.style.display = 'block';
      els.accountSelect.innerHTML = '';
      for (const acc of accounts) {
        const opt = document.createElement('option');
        opt.value = acc.accountKey;
        const state = !acc.signedIn ? '로그아웃' : acc.accountKey === auth.activeAccountKey ? '사용 중' : '연결됨';
        opt.textContent = `${acc.label || acc.email} · ${state}`;
        if (acc.accountKey === auth.activeAccountKey) opt.selected = true;
        els.accountSelect.appendChild(opt);
      }
    }
  } catch {
    pairCard.style.display = 'none';
    els.companionPill.textContent = '보조 앱 연결 필요';
    els.companionPill.className = 'pill err';
    els.asrStatus.textContent = '받아쓰기 연결 필요';
    els.offlineCard.style.display = 'flex';
    els.signedOutCard.style.display = 'none';
    els.signedInCard.style.display = 'none';
  }
}

els.gotItBtn.addEventListener('click', async () => {
  await apiFetch('/api/auth/confirm-welcome', { method: 'POST', body: {} });
  els.welcomeModal.classList.remove('open');
});

els.signOutBtn.addEventListener('click', async () => {
  await apiFetch('/api/auth/signout', { method: 'POST', body: {} });
  await chrome.storage.local.remove('lastAuthError').catch(() => {});
  await refreshStatus();
  await refreshVideoDetails();
});

els.modelSelect.addEventListener('change', async () => {
  await apiFetch('/api/auth/select-model', {
    method: 'POST',
    body: { model: els.modelSelect.value },
  });
  els.accountMeta.textContent = els.modelSelect.value;
});

els.accountSelect.addEventListener('change', async () => {
  const key = els.accountSelect.value;
  await apiFetch('/api/auth/select-account', {
    method: 'POST',
    body: { accountKey: key },
  });
  await refreshStatus();
  await refreshVideoDetails();
});

document.getElementById('newFromSignedOut').onclick = () => openAuth();
els.addAccountBtn.addEventListener('click', () => openAuth());
els.retryBtn.addEventListener('click', refreshStatus);
els.refreshBtn.addEventListener('click', () => { refreshStatus(); refreshVideoDetails(); });

const videoElements = Object.fromEntries([
  'videoHint','videoMetrics','playbackState','nativeAhead','subtitleAhead','preparationDetail','subtitleReadyLabel',
  'targetLanguage','customLanguageForm','customLanguage','languageHint',
  'lookAheadMode','lookAheadHint','preferenceStatus','tokenTotal','tokenBreakdown','tokenInput',
  'tokenOutput','tokenCached','tokenNote',
].map(id => [id, document.getElementById(id)]));

let videoRefreshPending = false;
let preferenceVersion = 0;
let currentTargetLanguage = DEFAULT_TARGET_LANGUAGE;
let targetLanguageVersion = 0;

function seconds(value) {
  return Number.isFinite(value) ? Math.max(0, value).toFixed(1) + '초' : '—';
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('ko-KR') : '—';
}

function selectTargetLanguage(language) {
  currentTargetLanguage = language;
  const known = SUBTITLE_LANGUAGES.some(([code]) => code === language);
  videoElements.targetLanguage.value = known ? language : 'custom';
  videoElements.customLanguageForm.hidden = known;
  if (!known) videoElements.customLanguage.value = language;
  videoElements.subtitleReadyLabel.textContent = targetLanguageName(language) + ' 자막 준비';
}

for (const [value, label] of [...SUBTITLE_LANGUAGES, ['custom', '다른 언어…']]) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  videoElements.targetLanguage.appendChild(option);
}
selectTargetLanguage(DEFAULT_TARGET_LANGUAGE);

async function applyTargetLanguage(value) {
  const language = normalizeTargetLanguage(value);
  if (!language) {
    videoElements.languageHint.textContent = '사용할 언어 코드를 확인해 주세요. 예를 들어 영어는 en, 중국어 번체는 zh-Hant입니다.';
    return;
  }
  const version = ++targetLanguageVersion;
  try {
    await chrome.storage.local.set({ targetLanguage: language });
    if (version !== targetLanguageVersion) return;
    selectTargetLanguage(language);
    const tab = await activeVideoTab();
    const reply = tab && await chrome.tabs.sendMessage(tab.id, {
      target: 'player', action: 'preferencesChanged', payload: { targetLanguage: language },
    }).catch(() => null);
    if (version !== targetLanguageVersion) return;
    videoElements.languageHint.textContent = reply?.ok
      ? targetLanguageName(language) + ' 자막으로 바꿨습니다.'
      : targetLanguageName(language) + '로 저장했습니다. 다음 자막 시작부터 적용됩니다.';
    await refreshVideoDetails();
  } catch {
    if (version === targetLanguageVersion) videoElements.languageHint.textContent = '언어 설정을 저장하지 못했습니다. 다시 선택해 주세요.';
  }
}

videoElements.targetLanguage.addEventListener('change', () => {
  if (videoElements.targetLanguage.value === 'custom') {
    videoElements.customLanguageForm.hidden = false;
    videoElements.customLanguage.value = SUBTITLE_LANGUAGES.some(([code]) => code === currentTargetLanguage) ? '' : currentTargetLanguage;
    return;
  }
  return applyTargetLanguage(videoElements.targetLanguage.value);
});
videoElements.customLanguageForm.addEventListener('submit', event => {
  event.preventDefault();
  return applyTargetLanguage(videoElements.customLanguage.value);
});

async function activeVideoTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return null;
  const url = new URL(tab.url);
  const videoId = url.searchParams.get('v');
  return url.origin === 'https://www.youtube.com' && url.pathname === '/watch' && videoId
    ? { id: tab.id, videoId } : null;
}

function showUnavailableVideo(message) {
  videoElements.videoMetrics.hidden = true;
  videoElements.videoHint.hidden = false;
  videoElements.videoHint.textContent = message;
  videoElements.playbackState.textContent = '시청 탭 필요';
  showTokenUsage(null, message);
}

function showTokenUsage(usage, emptyMessage = '계정 연결 후 사용량을 확인할 수 있습니다.') {
  videoElements.tokenCached.hidden = true;
  videoElements.tokenBreakdown.hidden = !usage;
  if (!usage) {
    videoElements.tokenTotal.textContent = '—';
    videoElements.tokenNote.textContent = emptyMessage;
    return;
  }
  const requests = Number.isSafeInteger(usage.requests) ? usage.requests : 0;
  const unknown = Number.isSafeInteger(usage.unknownRequests) ? usage.unknownRequests : 0;
  const hasKnownUsage = requests > unknown;
  videoElements.tokenTotal.textContent = hasKnownUsage || requests === 0 ? count(usage.totalTokens) : '확인 중';
  videoElements.tokenInput.textContent = hasKnownUsage || requests === 0 ? count(usage.inputTokens) : '—';
  videoElements.tokenOutput.textContent = hasKnownUsage || requests === 0 ? count(usage.outputTokens) : '—';
  if (Number.isSafeInteger(usage.cachedInputTokens) && usage.cachedInputTokens > 0) {
    videoElements.tokenCached.hidden = false;
    videoElements.tokenCached.textContent = '입력 중 캐시된 토큰 ' + count(usage.cachedInputTokens);
  }
  videoElements.tokenNote.textContent = unknown > 0
    ? '확인된 합계입니다. ' + count(unknown) + '건은 사용량 응답이 없어 합계에 포함되지 않았습니다.'
    : requests === 0
      ? '이 탭의 현재 영상·계정으로 기록된 번역이 없습니다.'
      : '이 탭·영상·계정에서 확인된 합계입니다. 저장된 번역 재생은 추가되지 않습니다.';
}

async function refreshVideoDetails() {
  if (videoRefreshPending) return;
  videoRefreshPending = true;
  try {
    const tab = await activeVideoTab();
    if (!tab) {
      showUnavailableVideo('YouTube 시청 탭을 열어 주세요.');
      return;
    }
    const [playback, metering] = await Promise.all([
      chrome.tabs.sendMessage(tab.id, { target: 'player', action: 'getPlaybackStatus' }).catch(() => null),
      chrome.runtime.sendMessage({ target: 'background', action: 'getTokenUsage', payload: { videoId: tab.videoId } }).catch(() => null),
    ]);
    if (!playback?.ok || playback.videoId !== tab.videoId) {
      videoElements.videoMetrics.hidden = true;
      videoElements.videoHint.hidden = false;
      videoElements.videoHint.textContent = '영상을 새로고침한 뒤 번역 자막을 켜 주세요.';
      videoElements.playbackState.textContent = '연결 확인 필요';
    } else {
      videoElements.videoHint.hidden = true;
      videoElements.videoMetrics.hidden = false;
      videoElements.nativeAhead.textContent = seconds(playback.nativeBufferedAheadSec);
      videoElements.subtitleAhead.textContent = seconds(playback.readyHorizonAhead);
      const target = seconds(playback.targetLeadSec);
      const rate = Number.isFinite(playback.playbackRate) ? playback.playbackRate : 1;
      videoElements.preparationDetail.textContent = '현재 시청 위치 기준 · 자막 목표 ' + target + (rate !== 1 ? ' · ' + rate + '배속' : '');
      videoElements.playbackState.textContent = !playback.active ? '자막 꺼짐'
        : playback.phase === 'buffering' || playback.phase === 'resyncing' ? '준비 중' : '자막 켜짐';
    }
    showTokenUsage(metering?.ok ? metering.usage : null);
  } catch {
    showUnavailableVideo('현재 시청 탭을 확인할 수 없습니다.');
  } finally {
    videoRefreshPending = false;
  }
}

videoElements.lookAheadMode.addEventListener('change', async () => {
  const version = ++preferenceVersion;
  const lookAheadMode = videoElements.lookAheadMode.value === 'extended' ? 'extended' : 'balanced';
  const feedback = videoElements.preferenceStatus;
  feedback.hidden = false;
  feedback.className = 'feedback';
  try {
    await chrome.storage.local.set({ lookAheadMode });
    const tab = await activeVideoTab();
    const reply = tab && await chrome.tabs.sendMessage(tab.id, {
      target: 'player', action: 'preferencesChanged', payload: { lookAheadMode },
    }).catch(() => null);
    if (version !== preferenceVersion) return;
    feedback.textContent = reply?.ok ? '현재 영상에 적용했습니다.' : '저장했습니다. 다음 자막 시작부터 적용됩니다.';
    await refreshVideoDetails();
  } catch {
    if (version !== preferenceVersion) return;
    feedback.className = 'feedback error';
    feedback.textContent = '설정을 저장하지 못했습니다. 다시 선택해 주세요.';
  }
});

chrome.storage.local.get(['lookAheadMode', 'targetLanguage']).then(({ lookAheadMode, targetLanguage }) => {
  if (preferenceVersion === 0) videoElements.lookAheadMode.value = lookAheadMode === 'extended' ? 'extended' : 'balanced';
  if (targetLanguageVersion === 0) selectTargetLanguage(normalizeTargetLanguage(targetLanguage) || DEFAULT_TARGET_LANGUAGE);
}).catch(() => {});

refreshStatus();
refreshVideoDetails();
setInterval(refreshVideoDetails, 1500);
