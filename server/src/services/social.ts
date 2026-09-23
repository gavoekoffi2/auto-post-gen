import { queryOne, transaction } from "../lib/db.js";
import { env } from "../lib/env.js";
import { HttpError, badRequest, notConfigured, notFound } from "../lib/errors.js";
import { ZernioClient, isSocialPlatform } from "../lib/zernio.js";
import { loadEntitlement, requireActiveEntitlement } from "./entitlement.js";

const provider = () => new ZernioClient(env.zernioKey, env.zernioUrl);

export async function connectSocial(profileId: string, platform: unknown) {
  if (!isSocialPlatform(platform)) throw badRequest("Réseau social non pris en charge.");
  if (!env.zernioKey) throw notConfigured("La connexion sociale nécessite ZERNIO_API_KEY.");
  let redirectUrl: string;
  try {
    const url = new URL("/profil", env.appPublicUrl);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error();
    redirectUrl = url.toString();
  } catch {
    throw notConfigured("La connexion sociale nécessite APP_PUBLIC_URL.");
  }
  const client = provider();
  // Serialise provisioning with other connects/syncs for this app profile.
  // A provider name conflict recovers the exact tenant on a retry, never Default.
  const providerProfileId = await transaction(async (db) => {
    const { rows } = await db.query<{ provider_profile_key: string | null }>(
      "SELECT provider_profile_key FROM profiles WHERE id = $1 FOR UPDATE", [profileId],
    );
    const profile = rows[0];
    if (!profile) throw notFound("Profil introuvable.");
    const existing = await db.query(
      `SELECT 1 FROM social_connections WHERE profile_id = $1 AND provider = 'zernio'
         AND platform = $2 AND provider_profile_key = $3 LIMIT 1`,
      [profileId, platform, profile.provider_profile_key],
    );
    if (!existing.rows.length) {
      const entitlement = await requireActiveEntitlement(profileId);
      const count = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM social_connections WHERE profile_id = $1 AND is_active", [profileId],
      );
      if ((count.rows[0]?.n ?? 0) >= entitlement.limits.socialAccounts) {
        throw new HttpError(403, "La limite de comptes sociaux de votre abonnement est atteinte.", "plan_limit_reached");
      }
    }
    if (profile.provider_profile_key) return profile.provider_profile_key;
    const key = await client.createProfile(profileId);
    await db.query("UPDATE profiles SET provider_profile_key = $2 WHERE id = $1", [profileId, key]);
    return key;
  });
  // Persist the mapping even if URL generation fails, so the next attempt reuses it.
  const connectUrl = await client.connect(platform, providerProfileId, redirectUrl);
  return { connectUrl, platform };
}

/** Refresh only a tenant that was explicitly provisioned by this app. */
export async function syncSocialAccounts(profileId: string): Promise<boolean> {
  const profile = await queryOne<{ provider_profile_key: string | null }>(
    "SELECT provider_profile_key FROM profiles WHERE id = $1", [profileId],
  );
  const key = profile?.provider_profile_key;
  if (!key) return false;
  if (!env.zernioKey) return true; // Existing metadata remains readable during configuration outages.
  const client = provider();
  await transaction(async (db) => {
    await db.query("SELECT id FROM profiles WHERE id = $1 FOR UPDATE", [profileId]);
    const accounts = await client.accounts(key);
    const entitlement = await loadEntitlement(profileId);
    const { rows: existing } = await db.query<{ account_id: string; platform: string; is_active: boolean }>(
      `SELECT account_id, platform, is_active FROM social_connections
       WHERE profile_id = $1 AND provider = 'zernio' AND provider_profile_key = $2`, [profileId, key],
    );
    const known = new Set(existing.map(row => `${row.platform}:${row.account_id}`));
    // Existing connections get priority. Concurrent OAuth flows must not turn
    // the preflight quota check into an unlimited number of usable accounts.
    accounts.sort((a, b) => Number(known.has(`${b.platform}:${b.id}`)) - Number(known.has(`${a.platform}:${a.id}`)));
    await db.query("UPDATE social_connections SET is_active = false WHERE profile_id = $1 AND provider = 'zernio'", [profileId]);
    const { rows: other } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM social_connections WHERE profile_id = $1 AND is_active", [profileId],
    );
    let activeCount = other[0]?.n ?? 0;
    const seen = new Set<string>();
    for (const account of accounts) {
      const identity = `${account.platform}:${account.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const active = account.active && activeCount < entitlement.limits.socialAccounts
        && (known.has(identity) || entitlement.canGenerate);
      if (active) activeCount++;
      await db.query(
        `INSERT INTO social_connections
           (profile_id, provider, platform, account_id, account_name, username, provider_profile_key, is_active)
         VALUES ($1, 'zernio', $2, $3, $4, $5, $6, $7)
         ON CONFLICT (profile_id, platform, account_id) DO UPDATE SET
           provider = 'zernio', account_name = EXCLUDED.account_name, username = EXCLUDED.username,
           provider_profile_key = EXCLUDED.provider_profile_key, is_active = EXCLUDED.is_active`,
        [profileId, account.platform, account.id, account.name, account.username, key, active],
      );
    }
  });
  return true;
}
