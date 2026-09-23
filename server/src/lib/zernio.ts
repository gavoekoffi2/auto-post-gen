import { HttpError, badRequest, notConfigured } from "./errors.js";

export const SOCIAL_PLATFORMS = ["linkedin", "facebook", "instagram", "twitter"] as const;
export type SocialPlatform = typeof SOCIAL_PLATFORMS[number];
export const isSocialPlatform = (value: unknown): value is SocialPlatform =>
  typeof value === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(value);

export interface ZernioAccount {
  id: string;
  platform: SocialPlatform;
  username: string | null;
  name: string | null;
  active: boolean;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const failure = () => new HttpError(502, "Le service de connexion sociale est indisponible. Réessayez plus tard.", "social_provider_error");

/** Server-only client. Never return or log raw provider responses (including tokens). */
export class ZernioClient {
  constructor(
    private readonly key: string | null,
    private readonly base: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  private async request(path: string, method = "GET", body?: object): Promise<{ status: number; data: Record<string, unknown> }> {
    if (!this.key) throw notConfigured("La connexion sociale nécessite ZERNIO_API_KEY.");
    try {
      const response = await this.fetcher(`${this.base.replace(/\/+$/, "")}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
      const data = record(await response.json());
      if (!response.ok && !(method === "POST" && path === "/profiles" && response.status === 409)) throw failure();
      return { status: response.status, data };
    } catch {
      throw failure();
    }
  }

  async createProfile(appProfileId: string): Promise<string> {
    if (!text(appProfileId)) throw badRequest("Profil requis.");
    // Unique deterministic names also recover safely after a DB rollback or a timeout.
    const { status, data } = await this.request("/profiles", "POST", { name: `prosocial_${appProfileId}` });
    const profile = record(data.profile);
    const id = status === 409 && data.code === "profile_name_conflict"
      ? text(record(data.details).existingProfileId)
      : status !== 409 && profile.isDefault !== true ? text(profile._id) : null;
    if (!id) throw failure();
    return id;
  }

  async connect(platform: SocialPlatform, profileId: string, redirectUrl: string): Promise<string> {
    if (!isSocialPlatform(platform)) throw badRequest("Réseau social non pris en charge.");
    if (!text(profileId)) throw badRequest("Profil fournisseur requis.");
    const params = new URLSearchParams({ profileId, redirect_url: redirectUrl });
    const { data } = await this.request(`/connect/${platform}?${params}`);
    const authUrl = text(data.authUrl);
    try {
      if (!authUrl || new URL(authUrl).protocol !== "https:") throw failure();
    } catch { throw failure(); }
    return authUrl!;
  }

  async accounts(profileId: string): Promise<ZernioAccount[]> {
    if (!text(profileId)) throw badRequest("Profil fournisseur requis.");
    const { data } = await this.request(`/accounts?${new URLSearchParams({ profileId })}`);
    if (!Array.isArray(data.accounts)) throw failure();
    const accounts: ZernioAccount[] = [];
    for (const value of data.accounts) {
      const account = record(value);
      const owner = text(account.profileId) ?? text(record(account.profileId)._id);
      // Defense in depth: never trust an unscoped or foreign account response.
      if (owner !== profileId || !isSocialPlatform(account.platform)) continue;
      const id = text(account._id);
      if (!id || typeof account.isActive !== "boolean") throw failure();
      accounts.push({ id, platform: account.platform, username: text(account.username),
        name: text(account.displayName) ?? text(account.name), active: account.isActive });
    }
    return accounts;
  }
}
