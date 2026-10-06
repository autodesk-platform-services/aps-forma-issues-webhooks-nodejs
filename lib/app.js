import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApsService, createUserAccessTokenProvider } from './aps.js';
import { createWebhookService, EVENTS, REGIONS, projectScope, httpsUrl } from './webhooks.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SESSION_TTL = 8 * 60 * 60 * 1000;
const random = () => randomBytes(32).toString('hex');
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const save = request => new Promise((resolve, reject) => request.session.save(error => error ? reject(error) : resolve()));

export function createApp(config, { aps = createApsService(config), webhooks = createWebhookService() } = {}) {
  const userAccessToken = createUserAccessTokenProvider(aps);
  const app = express();
  const accounts = new Map();
  const configured = Boolean(config.clientId && config.clientSecret && config.callbackUrl);
  app.disable('x-powered-by');
  if (config.trustProxy || config.ngrokUrl) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null } } }));
  app.use((request, response, next) => {
    for (const [id, account] of accounts) if (account.expiresAt < Date.now()) accounts.delete(id);
    next();
  });
  app.post('/api/callbacks/:id', rateLimit({ windowMs: 60000, limit: 120 }), express.raw({ type: 'application/json', limit: '256kb' }), (request, response) => {
    const account = [...accounts.values()].find(entry => entry.callbackId === request.params.id);
    if (!account) return response.sendStatus(404);
    if (!Buffer.isBuffer(request.body)) return response.sendStatus(415);
    const expected = Buffer.from(`sha1hash=${createHmac('sha1', account.signingToken).update(request.body).digest('hex')}`);
    const signature = Buffer.from(request.get('x-adsk-signature') ?? '');
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return response.sendStatus(403);
    let body;
    try { body = JSON.parse(request.body.toString('utf8')); } catch { return response.sendStatus(400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return response.sendStatus(400);
    account.deliveries.unshift({ id: random(), receivedAt: new Date().toISOString(), body });
    account.deliveries.length = Math.min(account.deliveries.length, 50);
    response.sendStatus(204);
  });
  app.use(express.json({ limit: '16kb' }));
  app.use(session({
    name: 'aps.sid', secret: config.sessionSecret, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: Boolean(config.secureCookies), maxAge: SESSION_TTL }
  }));
  app.use(['/api', '/auth'], (request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  app.get('/auth/login', rateLimit({ windowMs: 60000, limit: 20 }), async (request, response) => {
    if (!configured) throw fail(503, 'Configure APS_CLIENT_ID, APS_CLIENT_SECRET and APS_CALLBACK_URL in .env, then restart.');
    const state = random();
    const verifier = randomBytes(48).toString('base64url');
    request.session.oauth = { state, verifier, expiresAt: Date.now() + 10 * 60000 };
    await save(request);
    response.redirect(aps.authorize(state, createHash('sha256').update(verifier).digest('base64url')));
  });
  app.get('/auth/callback', async (request, response) => {
    const pending = request.session.oauth;
    delete request.session.oauth;
    await save(request);
    if (!pending || pending.expiresAt < Date.now() || typeof request.query.state !== 'string' || request.query.state !== pending.state) {
      return response.redirect('/?authError=state');
    }
    if (request.query.error || typeof request.query.code !== 'string') return response.redirect('/?authError=denied');
    try {
      const tokens = await aps.exchange(request.query.code, pending.verifier);
      const user = await aps.user(tokens.access_token);
      accounts.delete(request.session.authId);
      await new Promise((resolve, reject) => request.session.regenerate(error => error ? reject(error) : resolve()));
      const authId = random();
      accounts.set(authId, {
        tokens, tokenExpiresAt: Date.now() + tokens.expires_in * 1000,
        user: { name: user.name ?? user.userName ?? 'Autodesk user' },
        csrf: random(), callbackId: random(), signingToken: random(), deliveries: [],
        projects: new Set(), hubs: new Set(), visibleHooks: new Set(), expiresAt: Date.now() + SESSION_TTL
      });
      request.session.authId = authId;
      await save(request);
      response.redirect('/');
    } catch { response.redirect('/?authError=exchange'); }
  });

  function accountFor(request) { return accounts.get(request.session.authId); }
  function localCallback(account) {
    return config.ngrokUrl ? new URL(`/api/callbacks/${account.callbackId}`, httpsUrl(config.ngrokUrl)).href : null;
  }
  app.get('/api/session', (request, response) => {
    const account = accountFor(request);
    response.json({ configured, authenticated: Boolean(account), user: account?.user,
      csrf: account?.csrf, localCallbackUrl: account ? localCallback(account) : null, regions: REGIONS, events: EVENTS });
  });
  app.use('/api', (request, response, next) => {
    const account = accountFor(request);
    if (!account) throw fail(401, 'Your session has ended. Sign in with Autodesk again.');
    request.account = account;
    if (!['GET', 'HEAD'].includes(request.method) && request.get('x-csrf-token') !== account.csrf) throw fail(403, 'Invalid request token. Reload the page.');
    next();
  });
  app.post('/api/logout', async (request, response) => {
    accounts.delete(request.session.authId);
    await new Promise((resolve, reject) => request.session.destroy(error => error ? reject(error) : resolve()));
    response.clearCookie('aps.sid').sendStatus(204);
  });
  app.get('/api/hubs', async (request, response) => {
    try {
      const result = await aps.hubs(await userAccessToken(request.account));
      request.account.hubs = new Set(result.data.map(hub => hub.id));
      response.json(result);
    } catch (error) {
      if (error.status === 403 || error.response?.status === 403) {
        request.account.hubs.clear();
        response.json({ data: [], warnings: [], unprovisioned: true });
      } else throw error;
    }
  });
  app.get('/api/hubs/:hubId/projects', async (request, response) => {
    if (!request.account.hubs.has(request.params.hubId)) throw fail(403, 'Select an accessible hub first.');
    const result = await aps.projects(await userAccessToken(request.account), request.params.hubId);
    for (const project of result.data) request.account.projects.add(project.id);
    response.json(result);
  });
  function requireAccessibleProject(request, projectId) {
    if (!request.account.projects.has(projectId)) throw fail(403, 'Select an accessible project first.');
    if (!projectId.startsWith('b.')) throw fail(400, 'Issues webhooks require an ACC or BIM 360 project.');
  }
  app.get('/api/webhooks', async (request, response) => {
    const result = await webhooks.list(await userAccessToken(request.account));
    request.account.visibleHooks = new Set(result.hooks.map(hook => `${hook.region}:${hook.event}:${hook.hookId}`));
    response.json(result);
  });
  app.post('/api/webhooks', async (request, response) => {
    const { projectId, callbackType, region, event, hookAttribute } = request.body ?? {};
    requireAccessibleProject(request, projectId);
    if (!['local', 'explicit'].includes(callbackType)) throw fail(400, 'Select a callback type.');
    const callbackUrl = callbackType === 'local' ? localCallback(request.account) : request.body.callbackUrl;
    if (!callbackUrl) throw fail(400, 'Set NGROK_URL in .env and restart to enable local callbacks.');
    try {
      const hook = await webhooks.create(await userAccessToken(request.account), {
        projectId, region, event, hookAttribute, callbackUrl,
        signingToken: callbackType === 'local' ? request.account.signingToken : undefined
      });
      request.account.visibleHooks.add(`${hook.region}:${hook.event}:${hook.hookId}`);
      response.status(201).json(hook);
    } catch (error) {
      throw fail(error.status ?? 502, error.message);
    }
  });
  app.delete('/api/webhooks', async (request, response) => {
    const { region, event, hookId } = request.body ?? {};
    const key = `${region}:${event}:${hookId}`;
    if (!request.account.visibleHooks.has(key)) throw fail(404, 'This webhook is not in the current project list. Refresh the list and retry.');
    try {
      await webhooks.delete(await userAccessToken(request.account), { region, event, hookId });
      request.account.visibleHooks.delete(key);
      response.sendStatus(204);
    } catch (error) {
      throw fail(error.status ?? 502, error.message);
    }
  });
  app.get('/api/callbacks', (request, response) => {
    response.json(request.account.deliveries);
  });
  app.use('/vendor/lucide', express.static(`${ROOT}node_modules/lucide/dist/umd`));
  app.use('/fonts/sans', express.static(`${ROOT}node_modules/@fontsource/ibm-plex-sans/files`));
  app.use('/fonts/mono', express.static(`${ROOT}node_modules/@fontsource/ibm-plex-mono/files`));
  app.use(express.static(`${ROOT}public`));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = error.status ?? error.response?.status ?? 500;
    const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    response.status(safeStatus).json({ error: error.expose ? error.message : `Request failed (${safeStatus}). Check APS permissions and configuration, then retry.` });
  });
  return app;
}