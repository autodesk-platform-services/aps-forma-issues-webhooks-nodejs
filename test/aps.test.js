import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPages, createApsService, createUserAccessTokenProvider } from '../lib/aps.js';

test('Data Management pagination uses the next page number and preserves warnings', async () => {
  const result = await collectPages(async ({ pageNumber }) => pageNumber === undefined
    ? { data: [{ id: 'first' }], meta: { warnings: [{ title: 'Partial hub access' }] }, links: { next: { href: '?page[number]=1&page[limit]=100' } } }
    : { data: [{ id: 'second' }], links: {} });
  assert.deepEqual(result.data.map(item => item.id), ['first', 'second']);
  assert.equal(result.warnings.length, 1);
});

test('user access token comes from the OAuth session refresh flow, not client credentials', async () => {
  let refreshed = false;
  const aps = {
    refresh: async () => {
      refreshed = true;
      return { access_token: 'user-token', refresh_token: 'user-refresh', expires_in: 3600 };
    }
  };
  const userAccessToken = createUserAccessTokenProvider(aps);
  const account = { tokens: { access_token: 'expired', refresh_token: 'keep' }, tokenExpiresAt: 0 };
  assert.equal(await userAccessToken(account), 'user-token');
  assert.equal(refreshed, true);
  await assert.rejects(userAccessToken({ tokens: { access_token: 'only' } }), { status: 401 });
});

test('real APS authentication SDK constructs an authorization-code URL with PKCE', () => {
  const service = createApsService({ clientId: 'test-client', callbackUrl: 'http://localhost:3000/auth/callback' });
  const url = new URL(service.authorize('test-state', 'challenge'));
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'test-state');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('scope').includes('data:write'));
});