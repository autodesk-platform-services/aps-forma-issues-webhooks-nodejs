import { test, expect } from '@playwright/test';
import { REGIONS, EVENTS } from '../lib/webhooks.js';

const projectId = 'b.854c194f-05b3-4117-b926-69fa36c33c0c';
const hook = { region: 'US', hookId: 'c43bc871-d213-485a-9a52-84a9552df370', scope: { project: projectId.slice(2) }, event: 'issue.created-1.0', status: 'active', callbackUrl: 'https://sample.ngrok.app/callback' };

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`webhook workflow and layout on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const failures = [];
    const assetFailures = [];
    const creations = [];
    const deletions = [];
    let rejectCreation = false;
    page.on('pageerror', error => failures.push(error.message));
    page.on('response', response => {
      if (/\/(fonts|vendor|aps-logo\.svg)/.test(response.url()) && !response.ok()) assetFailures.push(response.url());
    });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/session') return json({ configured: true, authenticated: true, user: { name: 'Alex Morgan' }, csrf: 'csrf', localCallbackUrl: 'https://sample.ngrok.app/api/callbacks/sample-session', regions: REGIONS, events: EVENTS });
      if (url.pathname === '/api/hubs') return json({ data: [{ id: 'b.hub', attributes: { name: 'Construction / North America' } }] });
      if (url.pathname.endsWith('/projects')) return json({ data: [{ id: projectId, attributes: { name: 'Riverside Medical Center' } }, { id: 'b.other', attributes: { name: 'Station renovation' } }] });
      if (url.pathname === '/api/webhooks' && route.request().method() === 'POST') {
        creations.push(route.request().postDataJSON());
        if (rejectCreation) return route.fulfill({ status: 409, json: { error: 'A webhook already exists for this event.' } });
        return json({ ...hook, region: 'GBR', event: 'comment.created-1.0', hookId: 'new-hook-id' });
      }
      if (url.pathname === '/api/webhooks' && route.request().method() === 'DELETE') {
        deletions.push(route.request().postDataJSON());
        return route.fulfill({ status: 204, body: '' });
      }
      if (url.pathname === '/api/webhooks') return json({ hooks: [hook], unprovisioned: ['JPN', 'GBR'], errors: [] });
      if (url.pathname === '/api/callbacks') return json([{ id: 'delivery', receivedAt: '2026-09-28T12:00:00Z', body: { hook: { event: 'issue.created-1.0', scope: hook.scope }, payload: { projectId: hook.scope.project, issueId: 'sample-issue', status: 'open' } } }]);
      return route.fulfill({ status: 404, json: { error: 'Unexpected test route' } });
    });
    await page.goto('/');
    await expect(page.locator('#hooks-title')).toContainText('Registered Issues Webhooks');
    await expect(page.locator('#hooks-body tr')).toHaveCount(1);
    await expect(page.locator('#region-warning')).toHaveText('Unprovisioned regions: JPN, GBR');
    await expect(page.locator('body')).not.toContainText('APS returned');
    await expect(page.locator('.project-bar')).toBeHidden();
    await expect(page.locator('.hooks-section')).toHaveCSS('width', /\d+px/);
    await expect(page.locator('.workspace')).toContainText('New webhook');
    await expect(page.locator('.workspace')).toContainText('Local callback inbox');
    await expect(page.locator('#project-id')).toHaveValue(projectId.slice(2));
    await expect(page.locator('#project-id')).toHaveAttribute('readonly', '');
    await expect(page.locator('#callback-json')).toContainText('sample-issue');
    await expect(page.locator('#region option')).toHaveCount(8);
    await expect(page.locator('#event option')).toHaveCount(8);
    await page.locator('#region').selectOption('GBR');
    await page.locator('#event').selectOption('comment.created-1.0');
    await page.locator('#custom-data').fill('{bad json');
    await page.locator('#create-button').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#error-message')).toContainText('not valid JSON');
    await page.getByRole('button', { name: 'Dismiss' }).click();
    expect(creations).toHaveLength(0);
    await page.locator('#custom-data').fill('{"source":"sample"}');
    await page.locator('#create-button').click();
    await expect(page.locator('#hooks-body tr')).toHaveCount(2);
    expect(creations[0]).toMatchObject({ projectId, callbackType: 'local', hookAttribute: { source: 'sample' }, region: 'GBR' });
    await page.getByRole('button', { name: 'Delete issue.created-1.0 webhook in US' }).click();
    await expect(page.locator('#delete-dialog')).toBeVisible();
    await expect(page.locator('#delete-message')).toContainText('This permanently deletes');
    await page.getByRole('button', { name: 'Cancel deletion' }).click();
    await expect(page.locator('#hooks-body tr')).toHaveCount(2);
    await page.getByRole('button', { name: 'Delete issue.created-1.0 webhook in US' }).click();
    await page.getByRole('button', { name: 'Delete webhook', exact: true }).click();
    await expect(page.locator('#hooks-body tr')).toHaveCount(1);
    expect(deletions[0]).toMatchObject({ region: 'US', event: 'issue.created-1.0', hookId: hook.hookId });
    await page.getByRole('radio', { name: 'Explicit URL', exact: true }).check();
    await page.locator('#callback-url').fill('https://example.com/webhooks');
    rejectCreation = true;
    await page.locator('#create-button').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#error-message')).toContainText('already exists');
    expect(creations[1]).toMatchObject({ callbackType: 'explicit', callbackUrl: 'https://example.com/webhooks' });
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await page.getByRole('radio', { name: 'Local / ngrok', exact: true }).check();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('.brand-logo')).toBeVisible();
    expect(await page.locator('.brand svg').count()).toBe(1);
    await page.screenshot({ path: `test-results/workspace-${viewport.name}.png`, fullPage: true });
    await page.locator('#form-project').selectOption('b.other');
    await expect(page.locator('#hooks-body tr')).toHaveCount(1);
    await expect(page.locator('#callback-json')).toContainText('sample-issue');
    expect(failures).toEqual([]);
    expect(assetFailures).toEqual([]);
  });
}

test('unconfigured signed-out workspace loads and explains sign-in prerequisite', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#notice')).toHaveText('APS credentials are not configured.');
  await expect(page.locator('#hub')).toBeDisabled();
  await page.getByRole('button', { name: 'Sign in with Autodesk' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#error-message')).toContainText('APS_CLIENT_ID');
});

test('hub and project 403 responses never open an error dialog or show APS error details', async ({ page }) => {
  let hubForbidden = true;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/session') return route.fulfill({ json: { configured: true, authenticated: true, user: { name: 'Alex Morgan' }, csrf: 'csrf', localCallbackUrl: null, regions: REGIONS, events: EVENTS } });
    if (url.pathname === '/api/hubs' && hubForbidden) return route.fulfill({ status: 403, json: { error: 'private hub APS details' } });
    if (url.pathname === '/api/hubs') return route.fulfill({ json: {
      data: [{ id: 'b.hub', attributes: { name: 'Hub' } }],
      warnings: [{ detail: '403 BIM360DM_ERROR: Unable to get hubs from BIM360DM EMEA. You do not have permission to access this API.' }]
    } });
    if (url.pathname.endsWith('/projects')) return route.fulfill({ status: 403, json: { error: 'private project APS details' } });
    if (url.pathname === '/api/webhooks') return route.fulfill({ json: { hooks: [], unprovisioned: [], errors: [] } });
    if (url.pathname === '/api/callbacks') return route.fulfill({ json: [] });
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await expect(page.locator('#error-dialog')).not.toBeVisible();
  await expect(page.locator('body')).not.toContainText('private hub APS details');
  hubForbidden = false;
  await page.reload();
  await expect(page.locator('#form-project')).toHaveValue('');
  await expect(page.locator('#error-dialog')).not.toBeVisible();
  await expect(page.locator('body')).not.toContainText('private project APS details');
  await page.reload();
  await expect(page.locator('#region-warning')).toHaveText('Unprovisioned regions: EMEA');
  await expect(page.locator('body')).not.toContainText('BIM360DM_ERROR');
  await expect(page.locator('body')).not.toContainText('You do not have permission');
});