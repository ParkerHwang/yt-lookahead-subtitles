import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transcribeChunk } from '../asr.mjs';

const pcmBase64 = Buffer.from(new Int16Array(16000).fill(3000).buffer).toString('base64');

test('automatic ASR sends auto per request and returns the detected code with confidence', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { body }) => {
    assert.equal(body.get('language'), 'auto');
    assert.equal(body.has('prompt'), false, 'prior Japanese words must not bias a newly detected language');
    assert.equal(body.get('response_format'), 'verbose_json');
    return Response.json({ text: 'Hello everyone.', segments: [{ text: 'Hello everyone.', start: 0, end: 1 }],
      language: 'english', language_probabilities: { en: 0.99, ja: 0.001 } });
  };
  try {
    const result = await transcribeChunk({ pcmBase64, prompt: '前の日本語' });
    assert.equal(result.requestedLanguage, 'auto');
    assert.equal(result.detectedLanguage, 'en');
    assert.equal(result.detectedLanguageProbability, 0.99);
    assert.equal(result.rawText, 'Hello everyone.');
  } finally { globalThis.fetch = originalFetch; }
});

test('an explicit language retains the prompt and unsupported detection metadata stays unknown', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { body }) => {
    assert.equal(body.get('language'), 'fr');
    assert.equal(body.get('prompt'), 'Bonjour');
    return Response.json({ text: 'Bonjour.', segments: [] });
  };
  try {
    const result = await transcribeChunk({ pcmBase64, language: 'fr-FR', prompt: 'Bonjour' });
    assert.equal(result.requestedLanguage, 'fr');
    assert.equal(result.detectedLanguage, null);
    assert.equal(result.detectedLanguageProbability, null);
  } finally { globalThis.fetch = originalFetch; }
});

test('silence has no claimed language and invalid language is rejected before transcription', async () => {
  const result = await transcribeChunk({ pcmBase64: Buffer.alloc(32000).toString('base64') });
  assert.equal(result.skippedSilence, true);
  assert.equal(result.detectedLanguage, null);
  await assert.rejects(transcribeChunk({ pcmBase64, language: '<language>' }), /Invalid source language/);
});
