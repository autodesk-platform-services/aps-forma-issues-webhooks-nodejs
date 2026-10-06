import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createApp } from './lib/app.js';

const port = Number(process.env.PORT || 3000);
const config = {
  clientId: process.env.APS_CLIENT_ID,
  clientSecret: process.env.APS_CLIENT_SECRET,
  callbackUrl: process.env.APS_CALLBACK_URL || `http://localhost:${port}/auth/callback`,
  ngrokUrl: process.env.NGROK_URL,
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
  secureCookies: process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true'
};
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || !config.secureCookies)) {
  throw new Error('Production requires SESSION_SECRET and COOKIE_SECURE=true. Use a persistent session store before deployment.');
}
const server = createApp(config).listen(port, '127.0.0.1', () => {
  console.log(`Issues Webhooks: http://localhost:${port}`);
  if (!config.clientId || !config.clientSecret) console.log('APS credentials are not configured. See .env.example and README.md.');
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT to a free port and update APS_CALLBACK_URL.` : error.message);
  process.exitCode = 1;
});