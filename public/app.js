const element = id => document.getElementById(id);
const state = { session: null, hooks: [], unprovisioned: { hubs: [], projects: [], webhooks: [] }, deliveries: [], projectId: '', pendingDelete: null, hubVersion: 0, projectVersion: 0, listVersion: 0, creating: false, deleting: false, loadingHooks: false, callbackBusy: false };
lucide.createIcons();

function showError(error, title = 'Request failed') {
  if (error.status === 403) return;
  element('error-title').textContent = title;
  element('error-message').textContent = error.message ?? String(error);
  if (!element('error-dialog').open) element('error-dialog').showModal();
}
element('close-error').onclick = () => element('error-dialog').close();

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.session?.csrf ?? '', ...options.headers }
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      state.session.authenticated = false;
      state.projectId = '';
      state.projectVersion++;
      updateAuth();
      updateControls();
    }
    throw Object.assign(new Error(body.error ?? `Request failed (${response.status}).`), { status: response.status });
  }
  return body;
}

function notice(message) {
  element('notice').hidden = !message;
  element('notice').textContent = message;
}
function regionsFromWarnings(items) {
  const text = JSON.stringify(items ?? []);
  return state.session.regions.filter(region => new RegExp(`\\b${region}\\b`, 'i').test(text));
}
function setUnprovisioned(source, regions) {
  state.unprovisioned[source] = [...new Set(regions)];
  renderHooks();
}
function unprovisionedRegions() {
  return [...new Set(Object.values(state.unprovisioned).flat())];
}
function options(select, items, placeholder) {
  select.replaceChildren(new Option(placeholder, ''));
  for (const item of items) select.add(new Option(item.attributes?.name ?? item.id, item.id));
}
function updateAuth() {
  const authenticated = state.session?.authenticated;
  element('auth-label').textContent = authenticated ? 'Sign out' : 'Sign in with Autodesk';
  element('user-name').textContent = authenticated ? state.session.user.name : 'Not connected';
  element('connection').textContent = authenticated ? 'Connected' : 'Signed out';
  element('connection').classList.toggle('connected', Boolean(authenticated));
  element('reload-hubs').disabled = !authenticated;
}
function updateControls() {
  const enabled = Boolean(state.session?.authenticated && state.projectId.startsWith('b.'));
  element('create-fields').disabled = !enabled || state.creating;
  element('refresh-hooks').disabled = !state.session?.authenticated || state.loadingHooks || state.creating;
  element('form-project').disabled = !state.session?.authenticated || element('form-project').options.length < 2;
  element('form-hub').disabled = !state.session?.authenticated || element('form-hub').options.length < 2;
  element('create-label').textContent = state.creating ? 'Creating...' : 'Create webhook';
  element('project-id').value = state.projectId.replace(/^b\./, '');
}
function callbackMode() {
  const local = document.querySelector('input[name="callbackType"]:checked').value === 'local';
  const input = element('callback-url');
  input.readOnly = local;
  input.required = !local;
  input.value = local ? state.session?.localCallbackUrl ?? '' : input.dataset.explicit ?? '';
  input.placeholder = local ? 'NGROK_URL not configured' : 'https://example.com/webhooks';
  element('callback-label').textContent = local ? 'Local callback URL' : 'Explicit callback URL';
}
for (const radio of document.querySelectorAll('input[name="callbackType"]')) radio.onchange = callbackMode;
element('callback-url').oninput = event => { if (!event.target.readOnly) event.target.dataset.explicit = event.target.value; };

function renderHooks(emptyText = 'No webhooks for this project') {
  const body = element('hooks-body');
  body.replaceChildren();
  const sorted = [...state.hooks].sort((first, second) => first.region.localeCompare(second.region) || first.event.localeCompare(second.event));
  for (const hook of sorted) {
    const row = document.createElement('tr');
    for (const value of [hook.region, hook.scope?.project ?? '', hook.event, hook.callbackUrl ?? '']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    const status = document.createElement('td');
    const active = String(hook.status ?? '').toLowerCase() === 'active';
    status.append(Object.assign(document.createElement('span'), { className: `hook-status ${active ? 'active' : 'inactive'}`, textContent: active ? 'Active' : 'Inactive' }));
    row.append(status);
    const action = document.createElement('td');
    const remove = document.createElement('button');
    remove.className = 'icon-button delete-hook';
    remove.type = 'button';
    remove.title = 'Delete webhook';
    remove.setAttribute('aria-label', `Delete ${hook.event} webhook in ${hook.region}`);
    remove.innerHTML = '<i data-lucide="trash-2" aria-hidden="true"></i>';
    remove.disabled = state.deleting;
    remove.onclick = () => confirmDelete(hook);
    action.append(remove);
    row.append(action);
    body.append(row);
  }
  element('hook-count').textContent = state.hooks.length;
  element('hooks-empty').hidden = state.hooks.length > 0;
  element('empty-label').textContent = emptyText;
  const regionWarning = element('region-warning');
  const regions = unprovisionedRegions();
  regionWarning.hidden = regions.length === 0;
  regionWarning.textContent = regions.length ? `Unprovisioned regions: ${regions.join(', ')}` : '';
  lucide.createIcons();
}

async function loadHubs() {
  const version = ++state.hubVersion;
  element('hub').disabled = true;
  element('project').disabled = true;
  options(element('hub'), [], 'Loading hubs...');
  options(element('form-hub'), [], 'Loading hubs...');
  options(element('project'), [], 'No project selected');
  options(element('form-project'), [], 'No project selected');
  selectProject();
  try {
    const result = await api('/api/hubs');
    if (version !== state.hubVersion) return;
    options(element('hub'), result.data, result.data.length ? 'Select a hub' : 'No accessible hubs');
    options(element('form-hub'), result.data, result.data.length ? 'Select a hub' : 'No accessible hubs');
    element('hub').disabled = !result.data.length;
    element('form-hub').disabled = !result.data.length;
    setUnprovisioned('hubs', result.unprovisioned ? state.session.regions : regionsFromWarnings(result.warnings));
    if (result.unprovisioned) {
      return;
    }
    if (result.data.length) {
      element('hub').value = result.data[0].id;
      element('form-hub').value = result.data[0].id;
      await loadProjects();
    }
  } catch (error) {
    if (version !== state.hubVersion) return;
    options(element('hub'), [], 'Hubs unavailable');
    options(element('form-hub'), [], 'Hubs unavailable');
    if (error.status !== 403) showError(error);
  }
}

async function loadProjects() {
  const hubId = element('hub').value;
  const version = ++state.hubVersion;
  element('project').disabled = true;
  options(element('project'), [], hubId ? 'Loading projects...' : 'No project selected');
  options(element('form-project'), [], hubId ? 'Loading projects...' : 'No project selected');
  selectProject();
  if (!hubId) return;
  try {
    const result = await api(`/api/hubs/${encodeURIComponent(hubId)}/projects`);
    if (version !== state.hubVersion) return;
    options(element('project'), result.data, result.data.length ? 'Select a project' : 'No accessible projects');
    options(element('form-project'), result.data, result.data.length ? 'Select a project' : 'No accessible projects');
    element('project').disabled = !result.data.length;
    element('form-project').disabled = !result.data.length;
    setUnprovisioned('projects', regionsFromWarnings(result.warnings));
    if (result.data.length) {
      element('project').value = (result.data.find(project => project.id.startsWith('b.')) ?? result.data[0]).id;
      element('form-project').value = element('project').value;
      selectProject();
    }
  } catch (error) {
    if (version !== state.hubVersion) return;
    options(element('project'), [], 'Projects unavailable');
    options(element('form-project'), [], 'Projects unavailable');
    showError(error);
  }
}

function selectProject() {
  state.projectId = element('project').value;
  element('create-status').textContent = '';
  updateControls();
}

async function refreshHooks() {
  if (!state.session?.authenticated) return;
  const version = ++state.listVersion;
  state.loadingHooks = true;
  updateControls();
  element('hook-summary').textContent = 'Checking 8 regions...';
  try {
    const result = await api('/api/webhooks');
    if (version !== state.listVersion) return;
    state.hooks = result.hooks;
    state.unprovisioned.webhooks = result.unprovisioned ?? [];
    const unavailableCount = new Set([...state.unprovisioned.webhooks, ...state.unprovisioned.hubs]).size;
    const loadErrors = result.errors ?? [];
    element('hook-summary').textContent = `${state.hooks.length} hooks / ${8 - loadErrors.length - unavailableCount} of 8 regions loaded`;
    renderHooks('No webhooks found');
    if (loadErrors.length) {
      const regionWarning = element('region-warning');
      regionWarning.hidden = false;
      const unprovisioned = unprovisionedRegions();
      const parts = [];
      if (unprovisioned.length) parts.push(`Unprovisioned regions: ${unprovisioned.join(', ')}`);
      parts.push(`Region errors: ${loadErrors.map(entry => `${entry.region} (${entry.status ?? 'failed'})`).join(', ')}`);
      regionWarning.textContent = parts.join(' · ');
    }
  } catch (error) {
    if (version !== state.listVersion) return;
    element('hook-summary').textContent = 'Webhooks unavailable';
    renderHooks('Unable to load webhooks');
    showError(error);
  } finally {
    if (version === state.listVersion) { state.loadingHooks = false; updateControls(); }
  }
}

element('create-form').onsubmit = async event => {
  event.preventDefault();
  if (state.creating) return;
  const projectId = state.projectId;
  try {
    const custom = element('custom-data').value.trim();
    let hookAttribute;
    if (custom) {
      try { hookAttribute = JSON.parse(custom); } catch { throw new Error('Custom data is not valid JSON.'); }
      if (!hookAttribute || typeof hookAttribute !== 'object' || Array.isArray(hookAttribute)) throw new Error('Custom data must be a JSON object.');
      if (new TextEncoder().encode(JSON.stringify(hookAttribute)).length >= 1024) throw new Error('Custom data must be smaller than 1 KB.');
    }
    const callbackType = document.querySelector('input[name="callbackType"]:checked').value;
    if (callbackType === 'local' && !state.session.localCallbackUrl) throw new Error('Set NGROK_URL in .env and restart to enable local callbacks.');
    const input = { projectId, region: element('region').value, event: element('event').value, callbackType, callbackUrl: element('callback-url').value, hookAttribute };
    state.creating = true;
    state.listVersion++;
    state.loadingHooks = false;
    updateControls();
    element('create-status').textContent = '';
    const hook = await api('/api/webhooks', { method: 'POST', body: JSON.stringify(input) });
    state.hooks = state.hooks.filter(existing => existing.hookId !== hook.hookId || existing.region !== hook.region);
    state.hooks.push(hook);
    renderHooks();
    element('hook-summary').textContent = `${state.hooks.length} hooks / webhook created`;
    element('create-status').textContent = `Created ${hook.event} in ${hook.region} for ${projectId.replace(/^b\./, '')}.`;
  } catch (error) { showError(error, 'Webhook not created'); }
  finally { state.creating = false; updateControls(); }
};

async function confirmDelete(hook) {
  if (state.deleting) return;
  state.pendingDelete = hook;
  element('delete-message').textContent = `This permanently deletes the ${hook.event} webhook in ${hook.region} for project ${hook.scope?.project ?? state.projectId}. This cannot be undone.`;
  element('delete-dialog').showModal();
}
element('close-delete').onclick = () => element('delete-dialog').close();
element('cancel-delete').onclick = () => element('delete-dialog').close();
element('confirm-delete').onclick = async () => {
  const hook = state.pendingDelete;
  if (!hook || state.deleting) return;
  state.deleting = true;
  element('confirm-delete').disabled = true;
  try {
    await api('/api/webhooks', { method: 'DELETE', body: JSON.stringify({ region: hook.region, event: hook.event, hookId: hook.hookId }) });
    state.hooks = state.hooks.filter(item => item.region !== hook.region || item.hookId !== hook.hookId);
    renderHooks();
    element('hook-summary').textContent = `${state.hooks.length} hooks / webhook deleted`;
    element('delete-dialog').close();
  } catch (error) { showError(error, 'Webhook not deleted'); }
  finally { state.pendingDelete = null; state.deleting = false; element('confirm-delete').disabled = false; }
};

function renderDeliveries() {
  const select = element('delivery');
  const previous = select.value;
  select.replaceChildren();
  for (const delivery of state.deliveries) {
    const label = `${new Date(delivery.receivedAt).toLocaleTimeString()} / ${delivery.body.hook?.event ?? 'callback'}`;
    select.add(new Option(label, delivery.id));
  }
  if (!state.deliveries.length) select.add(new Option('No callbacks received', ''));
  if (!element('follow-latest').checked && state.deliveries.some(delivery => delivery.id === previous)) select.value = previous;
  select.disabled = !state.deliveries.length;
  element('delivery-count').textContent = state.deliveries.length;
  displayDelivery();
}
function displayDelivery() {
  const delivery = state.deliveries.find(item => item.id === element('delivery').value);
  element('callback-json').textContent = JSON.stringify(delivery?.body ?? {}, null, 2);
  element('copy-json').disabled = !delivery;
}
async function pollCallbacks() {
  if (!state.session?.authenticated || !state.session.localCallbackUrl) {
    element('callback-status').textContent = state.session?.authenticated ? 'Local receiver unavailable' : 'Not connected';
    return;
  }
  if (state.callbackBusy) return;
  state.callbackBusy = true;
  try {
    const deliveries = await api('/api/callbacks');
    state.deliveries = deliveries;
    renderDeliveries();
    element('callback-status').textContent = deliveries.length ? 'Receiver connected / signed deliveries' : 'Receiver connected / waiting for an event';
  } catch (error) {
    element('callback-status').textContent = error.message;
  } finally { state.callbackBusy = false; }
}
element('delivery').onchange = () => { element('follow-latest').checked = false; displayDelivery(); };
element('follow-latest').onchange = renderDeliveries;
element('copy-json').onclick = async () => {
  try { await navigator.clipboard.writeText(element('callback-json').textContent); element('callback-status').textContent = 'Callback JSON copied'; }
  catch { showError(new Error('Clipboard unavailable. Select the JSON and copy it manually.')); }
};
element('hub').onchange = () => { element('form-hub').value = element('hub').value; loadProjects(); };
element('form-hub').onchange = () => { element('hub').value = element('form-hub').value; loadProjects(); };
element('project').onchange = () => { element('form-project').value = element('project').value; selectProject(); };
element('form-project').onchange = () => { element('project').value = element('form-project').value; selectProject(); };
element('reload-hubs').onclick = loadHubs;
element('refresh-hooks').onclick = refreshHooks;
element('auth-button').onclick = async () => {
  if (!state.session?.authenticated) {
    if (!state.session?.configured) return showError(new Error('Configure APS_CLIENT_ID, APS_CLIENT_SECRET and APS_CALLBACK_URL in .env, then restart.'), 'APS configuration required');
    window.location.assign('/auth/login');
  } else {
    try { await api('/api/logout', { method: 'POST' }); window.location.assign('/'); }
    catch (error) { showError(error); }
  }
};

async function initialize() {
  try {
    state.session = await api('/api/session');
    element('region').replaceChildren(...state.session.regions.map(region => new Option(region, region)));
    element('event').replaceChildren(...state.session.events.map(event => new Option(`${event}${/^(comment|attachment)\./.test(event) ? ' (Beta)' : ''}`, event)));
    updateAuth();
    callbackMode();
    const authError = new URLSearchParams(window.location.search).get('authError');
    if (authError) {
      const messages = { state: 'Sign-in expired or the authorization state did not match. Sign in again.', denied: 'Autodesk sign-in was cancelled or denied.', exchange: 'Unable to complete Autodesk sign-in. Check your APS credentials and callback URL, then retry.' };
      showError(new Error(messages[authError] ?? 'Sign-in failed.'), 'Autodesk sign-in failed');
      history.replaceState(null, '', '/');
    }
    if (!state.session.configured) notice('APS credentials are not configured.');
    if (state.session.authenticated) {
      await Promise.all([loadHubs(), refreshHooks()]);
      pollCallbacks();
    }
  } catch (error) { showError(error); }
}
setInterval(() => { if (!document.hidden) pollCallbacks(); }, 2500);
initialize();