import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookService, REGIONS } from '../lib/webhooks.js';

test('lists every hook from every region, follows pages, and retains partial failures', async () => {
  const calls = [];
  const service = createWebhookService(async (url, options) => {
    calls.push({ url: String(url), region: options.headers.region });
    if (options.headers.region === 'EMEA') return new Response('', { status: 403 });
    const second = String(url).includes('pageState=page-2');
    assert.ok(String(url).includes('/systems/autodesk.construction.issues/hooks'));
    return Response.json({
      data: [{ hookId: second ? 'second' : 'first', scope: { project: 'project' } }, { hookId: 'other', scope: { project: 'other' } }],
      links: { next: second ? null : 'page-2' }
    });
  });
  const result = await service.list('token');
  assert.deepEqual([...new Set(calls.map(call => call.region))], REGIONS);
  assert.equal(result.hooks.length, 21);
  assert.deepEqual(result.unprovisioned, ['EMEA']);
  assert.deepEqual(result.errors, []);
  assert.ok(result.hooks.some(hook => hook.scope.project === 'other'));
});

test('deletes an Issues webhook with event path, region header, and bearer token', async () => {
  const service = createWebhookService(async (url, options) => {
    assert.equal(options.method, 'DELETE');
    assert.equal(options.headers.region, 'JPN');
    assert.equal(options.headers.Authorization, 'Bearer user-token');
    assert.ok(url.endsWith('/systems/autodesk.construction.issues/events/issue.updated-1.0/hooks/0f60f6a0-996c-11e7-abf3-51d68cff984c'));
    return new Response(null, { status: 204 });
  });
  assert.equal(await service.delete('user-token', { region: 'JPN', event: 'issue.updated-1.0', hookId: '0f60f6a0-996c-11e7-abf3-51d68cff984c' }), true);
  await assert.rejects(service.delete('user-token', { region: 'BAD', event: 'issue.updated-1.0', hookId: '0f60f6a0-996c-11e7-abf3-51d68cff984c' }), { status: 400 });
});

test('creates from an empty 201 response and Location, using region and normalized project scope', async () => {
  const service = createWebhookService(async (url, options) => {
    assert.ok(url.endsWith('/events/comment.created-1.0/hooks'));
    assert.equal(options.headers.region, 'GBR');
    assert.deepEqual(JSON.parse(options.body), { callbackUrl: 'https://example.com/callback', scope: { project: 'project' }, hookAttribute: { custom: true } });
    return new Response(null, { status: 201, headers: { Location: `${url}/new-id` } });
  });
  const hook = await service.create('token', { projectId: 'b.project', region: 'GBR', event: 'comment.created-1.0', callbackUrl: 'https://example.com/callback', hookAttribute: { custom: true } });
  assert.equal(hook.hookId, 'new-id');
  assert.equal(hook.region, 'GBR');
});

test('rejects invalid creation input before making an APS request', async () => {
  const service = createWebhookService(() => assert.fail('must not call APS'));
  const valid = { projectId: 'project', region: 'US', event: 'issue.created-1.0', callbackUrl: 'https://example.com' };
  for (const invalid of [{ region: 'BAD' }, { event: 'bad' }, { callbackUrl: 'http://localhost' }, { hookAttribute: [] }, { hookAttribute: { data: 'x'.repeat(1024) } }]) {
    await assert.rejects(service.create('token', { ...valid, ...invalid }), { status: 400 });
  }
});

test('does not forward credentials to an untrusted pagination URL', async () => {
  let calls = 0;
  const service = createWebhookService(async () => {
    calls++;
    return Response.json({ data: [], links: { next: 'https://example.com/steal' } });
  });
  const result = await service.list('token', 'project');
  assert.equal(calls, REGIONS.length);
  assert.equal(result.errors.length, REGIONS.length);
});