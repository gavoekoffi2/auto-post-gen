import test from 'node:test';
import assert from 'node:assert/strict';

test('Zernio uses documented scoped requests and sanitizes account metadata', async () => {
  const { ZernioClient } = await import('../dist/src/lib/zernio.js');
  const calls: { url: URL; init?: RequestInit }[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.pathname.endsWith('/profiles')) return Response.json({ profile: { _id: 'tenant-a' } });
    if (url.pathname.includes('/connect/')) return Response.json({ authUrl: 'https://oauth.test/auth' });
    return Response.json({ accounts: [{ _id: 'a', platform: 'linkedin', profileId: { _id: 'tenant-a' }, username: 'alice', isActive: true, accessToken: 'secret' }, { _id: 'b', platform: 'facebook', profileId: 'other' }] });
  };
  const client = new ZernioClient('key', 'https://zernio.com/api/v1/', mockFetch);
  assert.equal(await client.createProfile('app-a'), 'tenant-a');
  assert.equal(await client.connect('linkedin', 'tenant-a', 'https://app.test/profil'), 'https://oauth.test/auth');
  const accounts = await client.accounts('tenant-a');
  assert.equal(accounts.length, 1);
  assert.equal(JSON.stringify(accounts).includes('secret'), false);
  assert.equal(calls[1].url.pathname, '/api/v1/connect/linkedin');
  assert.equal(calls[1].init?.method, 'GET');
  assert.equal(calls[2].url.searchParams.get('profileId'), 'tenant-a');
  await assert.rejects(() => client.accounts(''));
  assert.equal(calls.length, 3);
});
test('profile name conflict recovers exact customer ID, never a default profile', async () => {
  const { ZernioClient } = await import('../dist/src/lib/zernio.js');
  const client = new ZernioClient('key', 'https://zernio.com/api/v1', async () => Response.json({ code: 'profile_name_conflict', details: { existingProfileId: 'specific-customer' } }, { status: 409 }));
  assert.equal(await client.createProfile('app-a'), 'specific-customer');
  const unsafe = new ZernioClient('key', 'https://zernio.com/api/v1', async () => Response.json({ profile: { _id: 'default', isDefault: true } }));
  await assert.rejects(() => unsafe.createProfile('app-a'));
});
test('malformed responses and network errors fail closed without leaking upstream data', async () => {
  const { ZernioClient } = await import('../dist/src/lib/zernio.js');
  for (const mockFetch of [async () => Response.json({ accounts: 'invalid' }), async () => { throw new Error('upstream-secret'); }]) {
    const client = new ZernioClient('key', 'https://zernio.com/api/v1', mockFetch);
    await assert.rejects(() => client.accounts('tenant'), (err: Error) => !err.message.includes('upstream-secret'));
  }
});
