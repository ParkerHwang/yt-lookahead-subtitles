/** Explicit replay of recognized dialogue and completed translations from an attested local run. */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const accountFingerprint = key => crypto.createHash('sha256').update('yt-test-account:' + key).digest('hex');
export const reportFingerprint = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const cueKey = line => JSON.stringify([line.text, Number(line.mediaStart), Number(line.mediaEnd)]);
function mergedIntervals(intervals) {
  const merged = [];
  for (const pair of intervals.sort((a,b) => a[0]-b[0])) {
    const last = merged.at(-1);
    if (last && pair[0] <= last[1] + 0.05) last[1] = Math.max(last[1], pair[1]);
    else merged.push([...pair]);
  }
  return merged;
}

export function createVerifiedReplay({ report, sha256, attestation, activeAccountKey, videoId, model, targetLanguage = 'ko', audioTrackId = 'und' }) {
  if (attestation.reportSha256 !== sha256 || attestation.accountFingerprint !== accountFingerprint(activeAccountKey) ||
      attestation.videoId !== videoId || attestation.model !== model ||
      targetLanguage !== 'ko' || audioTrackId !== 'und' || attestation.targetLanguage !== targetLanguage || attestation.audioTrackId !== audioTrackId) throw new Error('replay_provenance_mismatch');
  if (report.videoId !== videoId || report.kind !== 'REAL_YOUTUBE_CHATGPT_PLAN' || model !== 'gpt-6-luna' ||
      !report.events.some(event => event.type === 'translation_result' && event.ok && event.model === model && event.simulated === false)) {
    throw new Error('replay_source_not_real_matching_model');
  }
  const source = new Map(), translated = new Map();
  for (const sample of [...report.samples, report.final || {}]) for (const row of sample.lines || []) {
    if (typeof row.text !== 'string' || !Number.isFinite(row.mediaStart) || !Number.isFinite(row.mediaEnd) || row.mediaEnd <= row.mediaStart) continue;
    if (!/[\u3040-\u30ff]/u.test(row.text)) continue;
    const entry = { text: row.text, mediaStart: row.mediaStart, mediaEnd: row.mediaEnd };
    source.set(cueKey(row), entry);
    if (row.status === 'ready' && typeof row.ko === 'string' && row.ko.trim() && row.model === model && row.simulated === false) {
      translated.set(cueKey(row), { ...entry, ko: row.ko });
    }
  }
  const submitted = mergedIntervals(report.events.filter(event => event.type === 'asr_submitted').map(event => [event.start,event.end]).filter(pair => pair.every(Number.isFinite) && pair[1]>pair[0]));
  const rows = [...source.values()].sort((a,b) => a.mediaStart-b.mediaStart);
  const recognized = mergedIntervals(rows.map(row=>[row.mediaStart,row.mediaEnd]));
  const coverage = mergedIntervals(recognized.flatMap(([left,right])=>submitted.map(([start,end])=>[Math.max(left,start),Math.min(right,end)]).filter(pair=>pair[1]>pair[0])));
  return {
    provenance: { reportSha256: sha256, sourceDigests: report.sourceDigests, sourceRun: [report.startedAt,report.finishedAt],
      priorReportedSourceLanguages: [...new Set(report.samples.map(sample=>sample.sourceLanguage).filter(Boolean))],
      languageNote: 'Prior language labels are unverified metadata. Previously submitted source is reprocessed locally; cached text comes only from retained recognized cues.' },
    sourceCoverage: submitted,
    recognizedCoverage: coverage,
    translatedCount: translated.size,
    covered(start,end) { return submitted.some(([left,right]) => start >= left-0.001 && end <= right+0.001); },
    asrSegments(start,end) { return rows.filter(row => row.mediaEnd>start && row.mediaStart<end).map(row=>({...row,id:'replay-source-' + crypto.createHash('sha256').update(cueKey(row)).digest('hex').slice(0,16)})); },
    translated(line) { const row = translated.get(cueKey(line)); return row ? { id:line.id,ko:row.ko } : null; },
    hasSource(line) { return source.has(cueKey(line)); },
    sourceText(text) { return rows.some(row=>row.text===text); },
  };
}

export function loadVerifiedReplay({ reportPath, attestationPath, activeAccountKey, videoId, model }) {
  const bytes = fs.readFileSync(reportPath);
  return createVerifiedReplay({ report:JSON.parse(bytes),sha256:reportFingerprint(bytes),
    attestation:JSON.parse(fs.readFileSync(attestationPath,'utf8')), activeAccountKey,videoId,model });
}

export function mergeReplayTranslations(requested, cached, fresh) {
  const byId = new Map([...cached,...fresh].map(line=>[line.id,line]));
  const result = requested.map(line=>byId.get(line.id));
  if (result.some(line=>!line)) throw new Error('translation_missing_in_mixed_replay_batch');
  return result;
}

export function summarizeFreshUsage(events) {
  const freshCalls = events.filter(event=>event.type==='translation_submitted').length;
  const completed = events.filter(event=>event.type==='translation_result');
  const known = completed.filter(event=>['inputTokens','outputTokens','totalTokens'].every(key=>Number.isFinite(event.usage?.[key])&&event.usage[key]>=0));
  const sum = key => known.reduce((total,event)=>total+(Number.isFinite(event.usage[key]) ? event.usage[key] : 0),0);
  const replayed = events.filter(event=>event.type==='translation_replayed');
  return { freshCalls,knownUsageCalls:known.length,unknownUsageCalls:Math.max(0,freshCalls-known.length),
    knownInputTokens:sum('inputTokens'),knownOutputTokens:sum('outputTokens'),knownTotalTokens:sum('totalTokens'),
    knownCachedInputTokens:sum('cachedInputTokens'),allFreshUsageKnown:freshCalls===known.length,
    replayedCalls:replayed.length,replayedLines:replayed.reduce((total,event)=>total+event.count,0) };
}
