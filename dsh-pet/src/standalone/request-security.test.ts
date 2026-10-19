import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequestSecurity } from './request-security.ts';

function request(headers: Record<string, string> = {}, url = '/private', method = 'GET'): IncomingMessage {
  return {
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { localPort: 3080 },
    method,
    url,
  } as IncomingMessage;
}
function response() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
    },
    end() {},
  };
}
test('capabilities are random, fragment-only, and process-bound', () => {
  const a = createRequestSecurity();
  const b = createRequestSecurity();
  assert.notEqual(a.token, b.token);
  const url = new URL(a.authenticatedUrl('http://127.0.0.1:3080/dsh-pet'));
  assert.equal(url.pathname, '/standalone-ai/');
  assert.equal(url.search, '');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'), a.token);
  assert.throws(() => a.authenticatedUrl('https://evil.test/'));
});
test('all private reads and mutations need the header, never a query capability', () => {
  const security = createRequestSecurity();
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    for (const token of ['', 'wrong']) {
      const res = response();
      assert.equal(
        security.authorize(
          request({ 'x-dsh-pet-token': token }, '/private?token=' + security.token, method),
          res as unknown as ServerResponse,
        ),
        false,
      );
      assert.equal(res.status, 403);
    }
    assert.equal(
      security.authorize(
        request({ 'x-dsh-pet-token': security.token }, '/private', method),
        response() as unknown as ServerResponse,
      ),
      true,
    );
  }
});
test('DNS rebinding, null/foreign origins, wrong ports and cross-site fetches fail before auth', () => {
  const security = createRequestSecurity();
  const headersList: Array<Record<string, string>> = [
    { host: 'evil.test:3080' },
    { host: '127.0.0.1:9999' },
    { host: '' },
    { host: '127.0.0.1:3080.evil.test' },
    { origin: 'null' },
    { origin: 'http://evil.test' },
    { origin: 'http://localhost:3080' },
    { 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of headersList) {
    const res = response();
    assert.equal(
      security.authorize(request({ ...headers, 'x-dsh-pet-token': security.token }), res as unknown as ServerResponse),
      false,
      JSON.stringify(headers),
    );
  }
  assert.equal(
    security.authorize(
      request({ origin: 'http://127.0.0.1:3080', 'x-dsh-pet-token': security.token }),
      response() as unknown as ServerResponse,
    ),
    true,
  );
});
test('only minimal health, settings shell and known media GET are public; public routes still check origin/host', () => {
  const security = createRequestSecurity();
  for (const path of [
    '/',
    '/health',
    '/standalone-ai/',
    '/standalone-ai/settings.js',
    '/dsh-pet-7340/thumb/main/idle.webm',
    '/dsh-pet-7340/pic/memes/main/a.png',
  ]) {
    assert.equal(security.authorize(request({}, path), response() as unknown as ServerResponse), true, path);
    assert.equal(
      security.authorize(request({ origin: 'null' }, path), response() as unknown as ServerResponse),
      false,
      path,
    );
    assert.equal(security.authorize(request({}, path, 'POST'), response() as unknown as ServerResponse), false, path);
  }
  for (const path of ['/standalone-ai/settings', '/dsh-pet-7340/whisper', '/dsh-pet-7340/chat', '/shutdown']) {
    assert.equal(security.authorize(request({}, path), response() as unknown as ServerResponse), false, path);
  }
  for (const path of ['/dsh-pet-7340/config', '/dsh-pet-7340/state']) {
    assert.equal(security.authorize(request({}, path), response() as unknown as ServerResponse), true, path);
    assert.equal(
      security.authorize(request({ origin: 'http://evil.test' }, path), response() as unknown as ServerResponse),
      false,
      path,
    );
  }
});
