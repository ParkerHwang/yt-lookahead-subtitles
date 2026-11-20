(() => {
const DEFAULT_TARGET_LANGUAGE = 'ko';

const SUBTITLE_LANGUAGES = [
  ['ko', '한국어'], ['en', '영어'], ['ja', '일본어'],
  ['zh-Hans', '중국어 간체'], ['zh-Hant', '중국어 번체'],
  ['es', '스페인어'], ['fr', '프랑스어'], ['de', '독일어'], ['it', '이탈리아어'],
  ['pt', '포르투갈어'], ['pt-BR', '포르투갈어 (브라질)'], ['ru', '러시아어'],
  ['ar', '아랍어'], ['hi', '힌디어'], ['vi', '베트남어'], ['th', '태국어'],
  ['id', '인도네시아어'], ['tr', '튀르키예어'], ['uk', '우크라이나어'],
  ['nl', '네덜란드어'], ['pl', '폴란드어'], ['sv', '스웨덴어'], ['fi', '핀란드어'],
  ['el', '그리스어'], ['cs', '체코어'], ['ro', '루마니아어'], ['hu', '헝가리어'],
  ['fil', '필리핀어'], ['ms', '말레이어'], ['he', '히브리어'], ['fa', '페르시아어'],
  ['bn', '벵골어'], ['ta', '타밀어'],
];

function normalizeTargetLanguage(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().replaceAll('_', '-');
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/.test(code)) return null;
  try {
    const [canonical] = Intl.getCanonicalLocales(code);
    const language = canonical.split('-')[0].toLowerCase();
    return ['und', 'mul', 'zxx'].includes(language) ? null : canonical;
  } catch {
    return null;
  }
}

function targetLanguageName(value) {
  const code = normalizeTargetLanguage(value) || DEFAULT_TARGET_LANGUAGE;
  const listed = SUBTITLE_LANGUAGES.find(([language]) => language === code);
  if (listed) return listed[1];
  try {
    return new Intl.DisplayNames(['ko'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

  globalThis.YTSubtitleLanguages = { DEFAULT_TARGET_LANGUAGE, SUBTITLE_LANGUAGES, normalizeTargetLanguage, targetLanguageName };
})();
