export const REGIONS = ['US', 'EMEA', 'AUS', 'CAN', 'DEU', 'IND', 'JPN', 'GBR'];
export const EVENTS = [
  'issue.created-1.0', 'issue.updated-1.0', 'issue.deleted-1.0',
  'issue.restored-1.0', 'issue.unlinked-1.0', 'comment.created-1.0',
  'attachment.created-1.0', 'attachment.deleted-1.0'
];
export const SYSTEM = 'autodesk.construction.issues';
const ORIGIN = 'https://developer.api.autodesk.com';
const BASE = `${ORIGIN}/webhooks/v1/systems/${SYSTEM}`;

export function projectScope(projectId) {
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw Object.assign(new Error('A project is required.'), { status: 400 });
  }
  return projectId.replace(/^b\./, '');
}

export function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw Object.assign(new Error('Enter an HTTPS callback URL without credentials or a fragment.'), { status: 400 });
  }
  return url.toString();
}

function apsUrl(value, base = BASE) {
  const url = new URL(value, base);
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/webhooks/v1/')) {
    throw new Error('APS returned an unexpected webhook URL.');
  }
  return url;
}

const LIST_HOOKS_PATH = `${BASE}/hooks`;

function listHooksRequestUrl(pageState) {
  const url = apsUrl(LIST_HOOKS_PATH);
  if (pageState) url.searchParams.set('pageState', pageState);
  return url;
}

function nextListHooksTarget(link, currentUrl) {
  if (!link) return null;
  const value = typeof link === 'string' ? link : link.href;
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return { kind: 'url', url: apsUrl(value).href };
  }
  if (value.startsWith('?')) {
    return { kind: 'url', url: apsUrl(`${LIST_HOOKS_PATH}${value}`).href };
  }
  return { kind: 'pageState', pageState: value };
}

/** APS Issues webhook REST calls; `token` must be the signed-in user's three-legged OAuth bearer token. */
export function createWebhookService(fetchImpl = fetch) {
  async function request(url, token, region, { method, body } = {}) {
    const response = await fetchImpl(url, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { Authorization: `Bearer ${token}`, region, ...(body && { 'Content-Type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
      throw Object.assign(new Error(`APS Webhooks returned ${response.status} ${response.statusText} (${region}).`), { status: response.status });
    }
    return response;
  }

  return {
    async list(token) {
      const results = await Promise.all(REGIONS.map(async region => {
        const hooks = [];
        try {
          let pageState;
          let nextUrl;
          const visited = new Set();
          while (true) {
            const url = nextUrl ? apsUrl(nextUrl) : listHooksRequestUrl(pageState);
            const visitKey = nextUrl ?? pageState ?? '';
            if (visited.has(visitKey)) throw new Error('APS returned a pagination cycle.');
            visited.add(visitKey);
            const page = await (await request(url, token, region)).json();
            for (const hook of page.data ?? []) hooks.push({ ...hook, region });
            nextUrl = undefined;
            pageState = undefined;
            const next = nextListHooksTarget(page.links?.next, url);
            if (!next) break;
            if (next.kind === 'url') nextUrl = next.url;
            else pageState = next.pageState;
          }
          return { hooks };
        } catch (error) {
          return { hooks, ...(error.status === 403 ? { unprovisioned: region } : { error: { region, status: error.status, message: error.message } }) };
        }
      }));
      const unique = new Map(results.flatMap(result => result.hooks).map(hook => [`${hook.region}:${hook.hookId}`, hook]));
      return {
        hooks: [...unique.values()],
        unprovisioned: results.flatMap(result => result.unprovisioned ? [result.unprovisioned] : []),
        errors: results.flatMap(result => result.error ? [result.error] : [])
      };
    },

    async create(token, { projectId, region, event, callbackUrl, hookAttribute, signingToken }) {
      if (!REGIONS.includes(region) || !EVENTS.includes(event)) {
        throw Object.assign(new Error('Select a supported region and Issues event.'), { status: 400 });
      }
      const body = { callbackUrl: httpsUrl(callbackUrl), scope: { project: projectScope(projectId) } };
      if (hookAttribute !== undefined) {
        if (!hookAttribute || typeof hookAttribute !== 'object' || Array.isArray(hookAttribute) || Buffer.byteLength(JSON.stringify(hookAttribute)) >= 1024) {
          throw Object.assign(new Error('Custom data must be a JSON object smaller than 1 KB.'), { status: 400 });
        }
        body.hookAttribute = hookAttribute;
      }
      const response = await request(`${BASE}/events/${event}/hooks`, token, region, {
        method: 'POST', body: { ...body, ...(signingToken && { token: signingToken }) }
      });
      const location = response.headers.get('location');
      const text = await response.text();
      const created = text.trim() ? JSON.parse(text) : {};
      const hookId = created.hookId ?? (location ? apsUrl(location).pathname.split('/').pop() : null);
      if (!hookId) throw new Error('APS accepted the webhook but returned no hook ID. Refresh the list before retrying.');
      return { ...body, ...created, hookId, event, region, system: SYSTEM, status: created.status ?? 'active' };
    },

    async delete(token, { region, event, hookId }) {
      if (!REGIONS.includes(region) || !EVENTS.includes(event) || typeof hookId !== 'string' || !/^[a-f\d-]{1,80}$/i.test(hookId)) {
        throw Object.assign(new Error('Select a valid webhook to delete.'), { status: 400 });
      }
      const response = await request(`${BASE}/events/${encodeURIComponent(event)}/hooks/${encodeURIComponent(hookId)}`, token, region, { method: 'DELETE' });
      return response.status === 204 || response.ok;
    }
  };
}