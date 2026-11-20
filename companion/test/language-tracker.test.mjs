import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const scope = { atob, btoa };
vm.runInNewContext(fs.readFileSync(new URL('../../extension/language-tracker.js',import.meta.url),'utf8'),scope);
const { LanguageTracker } = scope.YTLookaheadLanguageTracker;
const pcmBase64 = Buffer.alloc(115200,10).toString('base64');
function chunk(start) { return { pcmBase64,sampleRate:16000,chunkStartMediaTime:start,chunkEndMediaTime:start+3.6 }; }
function vote(tracker,code,probability=.99,durationAudioSec=10) { return tracker.observe({detectedLanguage:code,detectedLanguageProbability:probability,durationAudioSec,probe:true}); }

test('startup accumulates contiguous unique audio and holds short guesses', () => {
  const t=new LanguageTracker();t.reset({videoId:'v',audioId:'original',generationId:1});
  t.addChunk(chunk(60));assert.equal(t.getProbeChunk(),null);
  assert.equal(t.observe({detectedLanguage:'ko',detectedLanguageProbability:.99,durationAudioSec:3.6}), 'auto');
  t.addChunk(chunk(63.25));assert.equal(t.getProbeChunk(),null);
  t.addChunk(chunk(66.5));const p=t.getProbeChunk();
  assert.equal(p.chunkStartMediaTime,60);assert.equal(p.chunkEndMediaTime,70.1);
  assert.ok(Math.abs(p.durationAudioSec-10.1)<.001);assert.equal(t.getProbeChunk(),null);
  assert.equal(vote(t,'ja',.89,p.durationAudioSec),'ja');
});

test('audio arriving during a probe is retained once with bounded pending chunks', () => {
  const t=new LanguageTracker();[60,63.25,66.5].forEach(s=>t.addChunk(chunk(s)));
  const p=t.getProbeChunk();[69.75,73].forEach(s=>t.addChunk(chunk(s)));
  vote(t,'en');const a=t.takePendingChunk(),b=t.takePendingChunk();
  assert.ok(Math.abs(a.chunkStartMediaTime-p.chunkEndMediaTime)<.0001);
  assert.equal(a.durationAudioSec,5.5);assert.ok(b.durationAudioSec<5.5);
  assert.ok(Math.abs(b.chunkStartMediaTime-a.chunkEndMediaTime)<.0001);
  assert.equal(t.takePendingChunk(),null);
});

test('all languages use evidence and a single contrary reaction cannot switch a session', () => {
  for(const code of ['en','ko','ja']){
    const t=new LanguageTracker();assert.equal(vote(t,code),code);
    assert.equal(vote(t,'fr',.99,.4),code);
    assert.equal(vote(t,'es',.4),code);
    assert.equal(vote(t,'es'),code);
    assert.equal(vote(t,code),code);
    assert.equal(vote(t,'es'),code);assert.equal(vote(t,'es'),'es');
    t.reset({videoId:'changed'});assert.equal(t.language,'auto');
  }
});

test('same audio retains the confirmed language over seeks while a new audio track resets it', () => {
  const t=new LanguageTracker();t.reset({videoId:'v',audioId:'a',generationId:1});vote(t,'ko');
  t.reset({videoId:'v',audioId:'a',generationId:2});assert.equal(t.language,'ko');
  t.reset({videoId:'v',audioId:'b',generationId:3});assert.equal(t.language,'auto');
});

test('a confirmed silent probe permits later speech to gather fresh language evidence', () => {
  const t=new LanguageTracker();[60,63.25,66.5].forEach(s=>t.addChunk(chunk(s)));
  const p=t.getProbeChunk();t.addChunk(chunk(69.75));
  t.observe({probe:true,skippedSilence:true,durationAudioSec:p.durationAudioSec});
  assert.equal(t.language,'auto');assert.equal(t.draining,false);
  [73,76.25,79.5].forEach(s=>t.addChunk(chunk(s)));
  const fresh=t.getProbeChunk();assert.ok(fresh.chunkStartMediaTime>=p.chunkEndMediaTime);
  assert.ok(fresh.durationAudioSec<=12);
  vote(t,'ko');assert.equal(t.language,'ko');
});

test('keeps actual playback speed despite clock jitter and starts new evidence after a rate change', () => {
  const t=new LanguageTracker();[60,63.25,66.5].forEach(start=>t.addChunk({...chunk(start),chunkEndMediaTime:start+3.603,playbackRate:1}));
  const p=t.getProbeChunk();assert.equal(p.playbackRate,1);
  t.addChunk({...chunk(70.1),playbackRate:1.5});assert.equal(t.getProbeChunk(),null);
  assert.equal(t.parts.length,1);assert.equal(t.parts[0].playbackRate,1.5);
});

test('substantial Japanese text corrects a contradictory Korean acoustic label from the real panel', () => {
  const t=new LanguageTracker();
  t.observe({ probe:true, detectedLanguage:'ko', detectedLanguageProbability:.99,durationAudioSec:10.1,
    rawText:'マフィアみたいなやつってたけど。懐かしいこの家。' });
  assert.equal(t.language,'ja');assert.equal(t.lastDecision.method,'transcript_script');
});

test('substantial Korean text corrects Japanese detection without assuming language from Han', () => {
  const t=new LanguageTracker();
  t.observe({probe:true,detectedLanguage:'ja',detectedLanguageProbability:.99,durationAudioSec:10,
    rawText:'오늘은 친구들과 함께 영상을 보면서 이야기를 나누고 있습니다.'});
  assert.equal(t.language,'ko');
  assert.equal(scope.YTLookaheadLanguageTracker.transcriptScriptEvidence('今天我们一起观看影片并且讨论剧情。').language,null);
});

test('short names, repeated reactions, and mixed Japanese and Korean do not force a language', () => {
  for(const text of ['はい。','ユナさん。','クリストファー・ロビンソン','はいはいはいはいはいはいはいはい。','고마워요.','そうなんですね。 함께 보고 있습니다.']){
    const t=new LanguageTracker();t.observe({probe:true,detectedLanguage:'ko',detectedLanguageProbability:.999,durationAudioSec:10,rawText:text});
    assert.equal(t.language,'auto',text);
  }
});
