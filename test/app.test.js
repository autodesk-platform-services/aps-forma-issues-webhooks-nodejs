import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../lib/app.js';

function fixture({ hubs } = {}) {
  let refreshes = 0;
  let created;
  let deleted;
  let listed;
  const aps = {
    authorize: state => `https://example.com/authorize?state=${state}`,
    exchange: async () => ({ access_token: 'private-token', refresh_token: 'private-refresh', expires_in: 0 }),
    refresh: async () => { refreshes++; return { access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 }; },
    user: async () => ({ name: 'Sample User' }),
    hubs: hubs ?? (async () => ({ data: [{ id: 'b.hub', attributes: { name: 'Hub' } }] })),
    projects: async () => ({ data: [{ id: 'b.project', attributes: { name: 'Project' } }] })
  };
  const webhooks = {
    list: async (...args) => { listed = args; return { hooks: [{ hookId: 'global-hook', region: 'JPN', scope: { project: 'unselected-project' }, event: 'issue.updated-1.0' }], unprovisioned: [], errors: [] }; },
    create: async (token, input) => { created = input; return { hookId: 'hook', region: input.region, scope: { project: 'project' }, event: input.event }; },
    delete: async (token, input) => { deleted = input; }
  };
  const app = createApp({ clientId: 'client', clientSecret: 'secret', callbackUrl: 'http://localhost/auth/callback', sessionSecret: 'test-session-secret', ngrokUrl: 'https://sample.ngrok.app' }, { aps, webhooks });
  return { app, agent: request.agent(app), get created() { return created; }, get deleted() { return deleted; }, get listed() { return listed; }, get refreshes() { return refreshes; } };
}

async function login(agent) {
  const start = await agent.get('/auth/login').expect(302);
  const state = new URL(start.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ state, code: 'code' }).expect(302).expect('Location', '/');
  return (await agent.get('/api/session').expect(200)).body;
}

test('OAuth rejects invalid state and unauthenticated API requests', async () => {
  const { agent } = fixture();
  await agent.get('/api/hubs').expect(401);
  await agent.get('/auth/login').expect(302);
  await agent.get('/auth/callback?state=bad&code=code').expect('Location', '/?authError=state');
  assert.equal((await agent.get('/api/session')).body.authenticated, false);
});

test('a hub-list 403 is returned as an unprovisioned state without exposing APS error text', async () => {
  const setup = fixture({ hubs: async () => { throw Object.assign(new Error('private APS provisioning details'), { status: 403 }); } });
  await login(setup.agent);
  const response = await setup.agent.get('/api/hubs').expect(200);
  assert.deepEqual(response.body, { data: [], warnings: [], unprovisioned: true });
  assert.ok(!JSON.stringify(response.body).includes('private APS provisioning details'));
});

test('sign-in, refresh, project authorization, CSRF, signed callback delivery and session isolation', async () => {
  const setup = fixture();
  const session = await login(setup.agent);
  assert.equal(session.authenticated, true);
  assert.ok(!JSON.stringify(session).includes('private-token'));
  await setup.agent.get('/api/hubs').expect(200);
  await setup.agent.get('/api/hubs/b.hub/projects').expect(200);
  assert.equal(setup.refreshes, 1);
  const globalHooks = await setup.agent.get('/api/webhooks').expect(200);
  assert.equal(globalHooks.body.hooks[0].hookId, 'global-hook');
  assert.deepEqual(setup.listed, ['new-token']);
  await setup.agent.get('/api/webhooks?projectId=b.other').expect(200);
  const globalDeliveries = await setup.agent.get('/api/callbacks').expect(200);
  assert.deepEqual(globalDeliveries.body, []);
  await setup.agent.post('/api/webhooks').set('x-csrf-token', session.csrf).send({ projectId: 'b.other', callbackType: 'local', region: 'US', event: 'issue.created-1.0' }).expect(403);
  await setup.agent.post('/api/webhooks').send({}).expect(403);
  await setup.agent.post('/api/webhooks').set('x-csrf-token', session.csrf).send({ projectId: 'b.project', callbackType: 'local', region: 'US', event: 'issue.created-1.0' }).expect(201);
  assert.equal(setup.created.callbackUrl, session.localCallbackUrl);
  await setup.agent.delete('/api/webhooks').set('x-csrf-token', session.csrf).send({ region: 'US', event: 'issue.created-1.0', hookId: 'unknown' }).expect(404);
  await setup.agent.delete('/api/webhooks').set('x-csrf-token', session.csrf).send({ region: 'US', event: 'issue.created-1.0', hookId: 'hook' }).expect(204);
  assert.deepEqual(setup.deleted, { region: 'US', event: 'issue.created-1.0', hookId: 'hook' });
  const path = new URL(session.localCallbackUrl).pathname;
  const body = JSON.stringify({ hook: { scope: { project: 'project' } }, payload: { id: 'issue' } });
  await request(setup.app).post(path).set('Content-Type', 'application/json').send(body).expect(403);
  const signature = `sha1hash=${createHmac('sha1', setup.created.signingToken).update(body).digest('hex')}`;
  await request(setup.app).post(path).set('Content-Type', 'application/json').set('x-adsk-signature', signature).send(body).expect(204);
  await request(setup.app).post(path).set('Content-Type', 'application/json').set('x-adsk-signature', signature).set('X-Forwarded-For', '203.0.113.50').send(body).expect(204);
  const deliveries = await setup.agent.get('/api/callbacks').expect(200);
  assert.equal(deliveries.body[0].body.payload.id, 'issue');
  const other = request.agent(setup.app);
  await login(other);
  await other.get('/api/hubs');
  await other.get('/api/hubs/b.hub/projects');
  assert.deepEqual((await other.get('/api/callbacks')).body, []);
  await setup.agent.post('/api/logout').set('x-csrf-token', session.csrf).expect(204);
  await setup.agent.get('/api/hubs').expect(401);
  await request(setup.app).post(path).set('Content-Type', 'application/json').send(body).expect(404);
});