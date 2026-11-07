import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRequest } from './request.ts';
import { sdkTextStream } from '../ai-transport.ts';
import { DEFAULT_AI_SETTINGS } from '../ai-config.ts';
import { parseTransientImage } from '../../host/transient-image.ts';

const image = { dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgD/2Q==', width: 1920, height: 1080 };
const options = {
  provider: 'standalone',
  model: 'test-model',
  system: 'inspect one frame',
  messages: [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'where is the NPC?' },
        { type: 'image', ...image },
      ],
    },
  ],
};

test('only a bounded current user image is accepted; remote URLs, old frames and assistant frames fail before transport', () => {
  const parsed = parseRequest(options, 'test-model');
  assert.deepEqual(parsed.request.messages.at(-1)?.images, [image]);
  assert.equal(parsed.request.messages[0].images, undefined);
  for (const patch of [
    { dataUrl: 'https://example.test/frame.jpg' },
    { dataUrl: 'data:image/jpeg;base64,bm90LWEtcGljdHVyZQ==' },
    { dataUrl: image.dataUrl + '\n' },
    { width: 1921 },
    { height: 0 },
  ])
    assert.throws(() => parseTransientImage({ ...image, ...patch }), /Invalid transient/);
  const oldImage = { role: 'user', content: [{ type: 'image', ...image }] };
  assert.throws(
    () => parseRequest({ ...options, messages: [oldImage, ...options.messages] }, 'test-model'),
    /current user message/,
  );
  assert.throws(
    () =>
      parseRequest({ ...options, messages: [{ ...oldImage, role: 'assistant' }, ...options.messages] }, 'test-model'),
    /current user message/,
  );
  assert.throws(
    () =>
      parseRequest(
        {
          ...options,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', ...image },
                { type: 'image', ...image },
              ],
            },
          ],
        },
        'test-model',
      ),
    /current user message/,
  );
});

test('OpenAI-compatible receives memory pixels as image_url and previous turns remain text-only', async () => {
  let called = false;
  const { request } = parseRequest(options, 'test-model');
  for await (const part of sdkTextStream(
    { ...DEFAULT_AI_SETTINGS, baseUrl: 'https://example.test/v1', apiKey: 'test-only', model: 'test-model' },
    request,
    new AbortController().signal,
    async (_url, init) => {
      called = true;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages[1].content, 'old question');
      assert.deepEqual(body.messages.at(-1).content, [
        { type: 'text', text: 'where is the NPC?' },
        { type: 'image_url', image_url: { url: image.dataUrl } },
      ]);
      assert.equal(JSON.stringify(body).includes('attachmentId'), false);
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"visible"}}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  ))
    assert.equal(part.text, 'visible');
  assert.equal(called, true);
});

test('Anthropic receives an in-memory base64 source with no disk attachment or URL fetch', async () => {
  const { request } = parseRequest(options, 'test-model');
  const output: string[] = [];
  for await (const part of sdkTextStream(
    {
      ...DEFAULT_AI_SETTINGS,
      protocol: 'anthropic',
      baseUrl: 'https://example.test',
      apiKey: 'test-only',
      model: 'test-model',
    },
    request,
    new AbortController().signal,
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.messages.at(-1).content, [
        { type: 'text', text: 'where is the NPC?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.dataUrl.split(',')[1] } },
      ]);
      return new Response(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"visible"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  ))
    if (part.text) output.push(part.text);
  assert.deepEqual(output, ['visible']);
});
