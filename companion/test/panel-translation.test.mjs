import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponsesRequestBody, extractTranslationsJson } from '../translator.mjs';

test('keeps speakers, nearby dialogue and previous Korean distinct from the cues to translate', () => {
  const lines = [
    { id: '22', speakerId: 'A', text: 'Tú también?', sourceLanguage: 'es' },
    { id: '23', speakerId: 'B', text: 'Me?\n진짜?', sourceLanguage: 'auto' },
  ];
  const body = buildResponsesRequestBody({ model: 'example', lines,
    contextLines: [{ id: '21', text: 'Yo también.', ko: '나도.' }],
    followingLines: [{ id: '24', text: 'Sí, tú.' }],
  });
  const input = JSON.parse(body.input[0].content);
  assert.deepEqual(input.context[0], { id: '21', text: 'Yo también.', ko: '나도.' });
  assert.deepEqual(input.lines, [
    { id:'22', speaker:'A', languageHint:'es', text:'Tú también?' },
    { id:'23', speaker:'B', text:'Me?\n진짜?' },
  ]);
  assert.deepEqual(input.following.map(cue => cue.id), ['24']);
  const ok = [{ id:'23', ko:'나?\n진짜?' }, { id:'22', ko:'너도?' }];
  const parse = items => extractTranslationsJson(JSON.stringify({ translations:items }), lines);
  assert.deepEqual(parse(ok).map(cue => cue.id), ['22', '23']);
  assert.throws(() => parse([...ok, ok[0]]));
  assert.throws(() => parse([...ok, { id:'24', ko:'응, 너.' }]));
});
