import { AuthenticationClient, ResponseType, Scopes } from '@aps_sdk/authentication';
import { DataManagementClient } from '@aps_sdk/data-management';

const SCOPES = [Scopes.DataRead, Scopes.DataWrite, Scopes.AccountRead, Scopes.UserProfileRead];
const OPTIONS = { timeout: 30000 };

export async function collectPages(load) {
  const data = [];
  const warnings = [];
  let pageNumber;
  let pageLimit;
  const visited = new Set();
  while (true) {
    const page = await load({ pageNumber, pageLimit });
    data.push(...(page.data ?? []));
    warnings.push(...(page.meta?.warnings ?? []));
    const next = page.links?.next;
    if (!next) break;
    const url = new URL(typeof next === 'string' ? next : next.href, 'https://developer.api.autodesk.com');
    const number = url.searchParams.get('page[number]');
    const limit = url.searchParams.get('page[limit]');
    if (number === null || !/^\d+$/.test(number) || visited.has(number)) {
      throw new Error('Unexpected Data Management pagination.');
    }
    visited.add(number);
    pageNumber = Number(number);
    pageLimit = limit && /^\d+$/.test(limit) ? Number(limit) : undefined;
  }
  return { data: [...new Map(data.map(item => [item.id, item])).values()], warnings };
}

/** Returns a refreshed three-legged user access token from the OAuth session (never client_credentials). */
export function createUserAccessTokenProvider(aps) {
  return async function userAccessToken(account) {
    if (!account?.tokens?.access_token || !account.tokens.refresh_token) {
      throw Object.assign(new Error('Autodesk authorization expired. Sign in again.'), { status: 401, expose: true });
    }
    if (account.tokenExpiresAt < Date.now() + 60000) {
      if (!account.refreshing) {
        account.refreshing = aps.refresh(account.tokens.refresh_token).then(tokens => {
          account.tokens = tokens;
          account.tokenExpiresAt = Date.now() + tokens.expires_in * 1000;
        }).catch(() => {
          account.expiresAt = 0;
          throw Object.assign(new Error('Autodesk authorization expired. Sign in again.'), { status: 401, expose: true });
        }).finally(() => { delete account.refreshing; });
      }
      await account.refreshing;
    }
    return account.tokens.access_token;
  };
}

export function createApsService(config, authentication = new AuthenticationClient(), dataManagement = new DataManagementClient()) {
  return {
    authorize(state, codeChallenge) {
      return authentication.authorize(config.clientId, ResponseType.Code, config.callbackUrl, SCOPES, {
        state, codeChallenge, codeChallengeMethod: 'S256', prompt: 'login'
      });
    },
    exchange(code, codeVerifier) {
      return authentication.getThreeLeggedToken(config.clientId, code, config.callbackUrl, {
        clientSecret: config.clientSecret, code_verifier: codeVerifier, options: OPTIONS
      });
    },
    refresh(refreshToken) {
      return authentication.refreshToken(refreshToken, config.clientId, {
        clientSecret: config.clientSecret, scopes: SCOPES, options: OPTIONS
      });
    },
    user(token) { return authentication.getUserInfo(token, { options: OPTIONS }); },
    hubs(accessToken) {
      return collectPages(({ pageNumber, pageLimit }) => dataManagement.getHubs({
        accessToken, options: { ...OPTIONS, params: { 'page[number]': pageNumber, 'page[limit]': pageLimit } }
      }));
    },
    projects(accessToken, hubId) {
      return collectPages(pagination => dataManagement.getHubProjects(hubId, {
        accessToken, ...pagination, options: OPTIONS
      }));
    }
  };
}