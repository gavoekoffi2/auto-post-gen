import test, { after, before } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_COOKIE_SECRET ??= "test-secret-that-is-long-enough-for-the-check";
process.env.NODE_ENV = "test";
process.env.ZERNIO_API_KEY = "mock-key";
process.env.APP_PUBLIC_URL = "https://app.example.test";
delete process.env.RESEND_API_KEY;
const { default: Fastify } = await import("fastify");
const { default: cookie } = await import("@fastify/cookie");
const { pool, query } = await import("../dist/src/lib/db.js");
const { HttpError } = await import("../dist/src/lib/errors.js");
const { authRoutes } = await import("../dist/src/routes/auth.js");
const { miscRoutes } = await import("../dist/src/routes/misc.js");
const app = Fastify();
await app.register(cookie, { secret: process.env.SESSION_COOKIE_SECRET });
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
  return reply.code(500).send({ error: String(err) });
});
await app.register(authRoutes);
await app.register(miscRoutes);
const realFetch = globalThis.fetch;
const calls: { url: URL; init?: RequestInit }[] = [];
let remoteAccounts: object[] = [];
let responseOverride: ((url: URL) => Response | undefined) | undefined;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  calls.push({ url, init });
  const override = responseOverride?.(url);
  if (override) return override;
  if (url.pathname.endsWith('/profiles')) {
    const name = JSON.parse(String(init?.body)).name;
    return Response.json({ profile: { _id: `remote-${name}`, isDefault: false } }, { status: 201 });
  }
  if (url.pathname.includes('/connect/')) return Response.json({ authUrl: 'https://provider.example.test/oauth' });
  if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: remoteAccounts });
  throw new Error('Unexpected provider request');
};
const users: { id: string; cookie: string }[] = [];
before(async () => {
  for (let i = 0; i < 2; i++) {
    const res = await app.inject({ method: 'POST', url: '/auth/register', remoteAddress: `10.77.${i}.1`, payload: {
      email: `social-${Date.now()}-${i}@example.test`, password: 'correct-horse-battery', requestedPlan: 'starter',
    } });
    assert.equal(res.statusCode, 201, res.body);
    const raw = res.headers['set-cookie'];
    users.push({ id: res.json().user.id, cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] });
  }
});
after(async () => {
  globalThis.fetch = realFetch;
  await query('DELETE FROM profiles WHERE id = ANY($1)', [users.map(u => u.id)]);
  await app.close();
  await pool.end();
});
const connect = (i = 0, platform = 'linkedin') => app.inject({ method: 'POST', url: '/social/connect', headers: { cookie: users[i].cookie }, payload: { platform, profileId: 'attacker', redirect_url: 'https://evil.test' } });
const list = (i = 0) => app.inject({ method: 'GET', url: '/social/accounts', headers: { cookie: users[i].cookie } });

test('authentication and platform allow-list reject before contacting provider', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/social/connect', payload: { platform: 'linkedin' } })).statusCode, 401);
  assert.equal((await connect(0, 'youtube')).statusCode, 400);
  assert.equal(calls.length, 0);
});
test('connect creates and reuses one isolated profile per app profile', async () => {
  for (const i of [0, 0, 1]) {
    const res = await connect(i);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { connectUrl: 'https://provider.example.test/oauth', platform: 'linkedin' });
  }
  const creates = calls.filter(c => c.url.pathname.endsWith('/profiles'));
  assert.equal(creates.length, 2);
  const links = calls.filter(c => c.url.pathname.includes('/connect/'));
  assert.equal(links[0].url.searchParams.get('profileId'), links[1].url.searchParams.get('profileId'));
  assert.notEqual(links[0].url.searchParams.get('profileId'), links[2].url.searchParams.get('profileId'));
  assert.equal(links[0].init?.method, 'GET');
  assert.equal(new URL(links[0].url.searchParams.get('redirect_url')!).origin, 'https://app.example.test');
});
test('account sync is profile-scoped, strips tokens, and deactivates missing accounts', async () => {
  const key = calls.find(c => c.url.pathname.includes('/connect/'))!.url.searchParams.get('profileId');
  remoteAccounts = [{ _id: 'a1', platform: 'linkedin', profileId: key, username: 'alice', isActive: true, accessToken: 'DO-NOT-STORE' },
    { _id: 'foreign', platform: 'facebook', profileId: 'other-tenant', isActive: true },
    { _id: 'unsupported', platform: 'youtube', profileId: key, isActive: true }];
  const res = await list();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().accounts.length, 1);
  const rows = await query('SELECT * FROM social_connections WHERE profile_id = $1', [users[0].id]);
  assert.equal(JSON.stringify(rows).includes('DO-NOT-STORE'), false);
  assert.equal(calls.at(-1)!.url.searchParams.get('profileId'), key);
  remoteAccounts = [];
  assert.equal((await list()).json().accounts[0].is_active, false);
});
test('new networks require entitlement, but existing network repairs remain allowed', async () => {
  await query("UPDATE profiles SET subscription_status = 'trialing', trial_ends_at = now() - interval '1 day' WHERE id = $1", [users[0].id]);
  assert.equal((await connect(0, 'facebook')).statusCode, 402);
  assert.equal((await connect()).statusCode, 200);
});
test('new networks stop at the server socialAccounts limit', async () => {
  await query("UPDATE profiles SET plan = 'starter', subscription_status = 'active', current_period_ends_at = NULL WHERE id = $1", [users[0].id]);
  await query("UPDATE social_connections SET is_active = true WHERE profile_id = $1", [users[0].id]);
  await query("INSERT INTO social_connections (profile_id, provider, platform, account_id, provider_profile_key) SELECT id, 'zernio', 'facebook', 'a2', provider_profile_key FROM profiles WHERE id = $1", [users[0].id]);
  const res = await connect(0, 'instagram');
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().code, 'plan_limit_reached');
});
test('provider errors are sanitized, without default-profile fallback', async () => {
  const start = calls.length;
  responseOverride = url => url.pathname.includes('/connect/') ? Response.json({ error: 'SECRET-UPSTREAM' }, { status: 500 }) : undefined;
  const res = await connect();
  responseOverride = undefined;
  assert.equal(res.statusCode, 502, res.body);
  assert.equal(res.body.includes('SECRET-UPSTREAM'), false);
  assert.equal(calls.length, start + 1);
});
