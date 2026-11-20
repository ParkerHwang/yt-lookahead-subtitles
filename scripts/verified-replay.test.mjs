import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFingerprint, createVerifiedReplay, mergeReplayTranslations } from './verified-replay.mjs';
const row = { id:'L1',text:'懐かしいこの家。',mediaStart:230,mediaEnd:234,ko:'이 집, 오랜만이네.',status:'ready',model:'gpt-6-luna',simulated:false };
const report = { kind:'REAL_YOUTUBE_CHATGPT_PLAN',videoId:'2LSJpvd9MwI',events:[{type:'asr_submitted',start:226.5,end:236.5},{type:'translation_result',ok:true,model:'gpt-6-luna',simulated:false}],samples:[{lines:[row],sourceLanguage:'ko'}] };
const args = { report,sha256:'test-source-hash',attestation:{reportSha256:'test-source-hash',accountFingerprint:accountFingerprint('account1'),videoId:report.videoId,model:'gpt-6-luna',targetLanguage:'ko',audioTrackId:'und'},activeAccountKey:'account1',videoId:report.videoId,model:'gpt-6-luna' };
test('replay requires attested same report, account, video and real model', () => {
  for(const override of [{activeAccountKey:'account2'},{sha256:'changed'},{videoId:'other'},{model:'gpt-6.2-sol'},{targetLanguage:'en'},{audioTrackId:'en.1'}])assert.throws(()=>createVerifiedReplay({...args,...override}),/provenance/);
  assert.throws(()=>createVerifiedReplay({...args,report:{...report,events:[]}}),/real_matching/);
});
test('replay is exact in text and source time while new IDs preserve requested order', () => {
  const replay=createVerifiedReplay(args);
  assert.deepEqual(replay.translated({...row,id:'new-id'}),{id:'new-id',ko:row.ko});
  assert.equal(replay.translated({...row,text:'different'}),null);
  assert.equal(replay.translated({...row,mediaStart:230.1}),null);
  assert.equal(replay.covered(230,234),true);
  assert.equal(replay.covered(227,237),false);
  assert.equal(replay.covered(226.5,230),true);
  assert.deepEqual(replay.asrSegments(226.5,229),[]);
  const first = replay.asrSegments(232,235)[0];
  assert.equal(first.text,row.text);
  assert.equal(first.mediaStart,230);
  assert.equal(first.id,replay.asrSegments(233,236)[0].id);
  assert.match(replay.provenance.languageNote,/unverified/);
});

test('mixed replay and fresh translations retain the current batch ID order', () => {
  const requested=[{id:'new-a'},{id:'new-b'},{id:'new-c'}];
  const cached=[{id:'new-c',ko:'셋'},{id:'new-a',ko:'하나'}];
  const fresh=[{id:'new-b',ko:'둘'}];
  assert.deepEqual(mergeReplayTranslations(requested,cached,fresh).map(row=>row.ko),['하나','둘','셋']);
  assert.throws(()=>mergeReplayTranslations(requested,cached,[]),/missing_in_mixed/);
});

import { summarizeFreshUsage } from './verified-replay.mjs';
test('fresh token totals distinguish missing usage and never import cached usage', () => {
  const events=[{type:'translation_submitted'},{type:'translation_result',usage:{inputTokens:10,outputTokens:3,totalTokens:13,cachedInputTokens:2}},
    {type:'translation_submitted'},{type:'translation_result',usage:null},{type:'translation_replayed',count:4,usage:{totalTokens:9999}}];
  const usage=summarizeFreshUsage(events);
  assert.equal(usage.knownTotalTokens,13);
  assert.equal(usage.freshCalls,2);
  assert.equal(usage.unknownUsageCalls,1);
  assert.equal(usage.replayedLines,4);
  assert.equal(usage.allFreshUsageKnown,false);
  assert.deepEqual(summarizeFreshUsage([{type:'translation_replayed',count:2}]),{freshCalls:0,knownUsageCalls:0,unknownUsageCalls:0,knownInputTokens:0,knownOutputTokens:0,knownTotalTokens:0,knownCachedInputTokens:0,allFreshUsageKnown:true,replayedCalls:1,replayedLines:2});
});
