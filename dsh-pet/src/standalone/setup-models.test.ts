import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { checkEmbedding, setupErrorMessage } from './setup-models.ts';

for (const scenario of ['ok', 'dimension', 'authentication', 'quota', 'not_found'] as const)
  test('embedding preflight reports ' + scenario + ' without leaking provider details', async (t) => {
    const code = { ok: 200, dimension: 200, authentication: 401, quota: 429, not_found: 404 }[scenario];
    let auth = '';
    const server = createServer((req, res) => {
      auth = req.headers.authorization ?? '';
      res.statusCode = code;
      res.end(
        code === 200
          ? JSON.stringify({ data: [{ embedding: scenario === 'dimension' ? [1] : [1, 2] }] })
          : 'private-provider-secret',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const models = {
      baseUrl: 'https://chat.example/v1',
      model: 'chat',
      apiKey: 'chat-key',
      embeddingBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      embeddingModel: 'vector',
      embeddingApiKey: 'embedding-key',
      embeddingDimension: 2,
    };
    if (scenario === 'ok') await checkEmbedding(models, new AbortController().signal);
    else
      await assert.rejects(checkEmbedding(models, new AbortController().signal), (error: Error) => {
        assert.equal(error.message, 'embedding_' + scenario);
        assert.ok(!setupErrorMessage(error).includes('private-provider-secret'));
        return true;
      });
    assert.equal(auth, 'Bearer embedding-key');
  });
