// Shared Postiz API client used by the publish / integrations edge functions.
// API reference: https://docs.postiz.com/public-api

export const DEFAULT_POSTIZ_BASE_URL = 'https://api.postiz.com/public/v1';

// Postiz platform keys (settings.__type).
// Mapping is intentionally permissive: Postiz itself is the source of truth
// for which channels are actually connected. We only use this to filter
// which Postiz integration maps to which platform label used in our UI.
export const POSTIZ_PLATFORM_ALIASES: Record<string, string[]> = {
  Instagram: ['instagram', 'instagram-standalone'],
  Facebook: ['facebook'],
  Twitter: ['x', 'twitter'],
  LinkedIn: ['linkedin', 'linkedin-page'],
  TikTok: ['tiktok'],
  YouTube: ['youtube'],
  Pinterest: ['pinterest'],
  Threads: ['threads'],
  Reddit: ['reddit'],
  Bluesky: ['bluesky'],
  Mastodon: ['mastodon'],
  Discord: ['discord'],
  Slack: ['slack'],
};

export type PostizIntegration = {
  id: string;
  name?: string;
  identifier?: string;
  picture?: string;
  providerIdentifier?: string;
  disabled?: boolean;
};

export class PostizClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_POSTIZ_BASE_URL,
  ) {
    if (!apiKey) throw new Error('Postiz API key missing');
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Leave as text.
    }

    if (!res.ok) {
      const message =
        (payload && typeof payload === 'object' && 'message' in payload
          ? (payload as { message: string }).message
          : typeof payload === 'string'
            ? payload
            : `HTTP ${res.status}`);
      throw new PostizError(
        typeof message === 'string' ? message : `Postiz error ${res.status}`,
        res.status,
        payload,
      );
    }

    return payload as T;
  }

  async listIntegrations(): Promise<PostizIntegration[]> {
    const data = await this.request<PostizIntegration[] | { integrations: PostizIntegration[] }>(
      '/integrations',
      { method: 'GET' },
    );
    if (Array.isArray(data)) return data;
    if (data && Array.isArray((data as any).integrations)) {
      return (data as any).integrations;
    }
    return [];
  }

  async uploadImageFromUrl(imageUrl: string): Promise<string | null> {
    try {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) return null;
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      const blob = await imgRes.blob();

      const form = new FormData();
      const filename = imageUrl.split('/').pop()?.split('?')[0] || 'upload.jpg';
      form.append('file', new File([blob], filename, { type: contentType }));

      const url = `${this.baseUrl.replace(/\/$/, '')}/upload`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: this.apiKey },
        body: form,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.path || data?.url || null;
    } catch (err) {
      console.error('Postiz upload failed:', err);
      return null;
    }
  }

  async createPost(input: {
    type: 'schedule' | 'now';
    date: string; // ISO 8601
    posts: Array<{
      integration: { id: string };
      value: Array<{ content: string; image?: Array<{ path: string }> }>;
      settings?: Record<string, unknown>;
    }>;
  }): Promise<{ id?: string; posts?: Array<{ id?: string }> }> {
    return this.request('/posts', {
      method: 'POST',
      body: JSON.stringify({
        type: input.type,
        date: input.date,
        shortLink: false,
        tags: [],
        posts: input.posts,
      }),
    });
  }
}

export class PostizError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: unknown,
  ) {
    super(message);
    this.name = 'PostizError';
  }
}

// Map a label used in our UI (e.g. "Instagram") to the Postiz integrations
// that match. Returns the first enabled integration for that platform.
export function findIntegrationForPlatform(
  platformLabel: string,
  integrations: PostizIntegration[],
): PostizIntegration | null {
  const aliases =
    POSTIZ_PLATFORM_ALIASES[platformLabel] ??
    [platformLabel.toLowerCase()];
  return (
    integrations.find(
      (it) =>
        !it.disabled &&
        it.providerIdentifier &&
        aliases.includes(it.providerIdentifier.toLowerCase()),
    ) || null
  );
}

// Some Postiz providers require specific settings.__type to accept a post.
export function defaultSettingsForProvider(
  providerIdentifier: string | undefined,
): Record<string, unknown> {
  const key = providerIdentifier?.toLowerCase() ?? '';
  switch (key) {
    case 'x':
    case 'twitter':
      return { __type: 'x', who_can_reply_post: 'everyone' };
    case 'instagram':
    case 'instagram-standalone':
      return { __type: 'instagram' };
    case 'facebook':
      return { __type: 'facebook' };
    case 'linkedin':
    case 'linkedin-page':
      return { __type: 'linkedin' };
    case 'tiktok':
      return { __type: 'tiktok', privacy_level: 'PUBLIC_TO_EVERYONE' };
    case 'youtube':
      return { __type: 'youtube', privacyLevel: 'public' };
    case 'threads':
      return { __type: 'threads' };
    case 'pinterest':
      return { __type: 'pinterest' };
    case 'reddit':
      return { __type: 'reddit' };
    case 'bluesky':
      return { __type: 'bluesky' };
    case 'mastodon':
      return { __type: 'mastodon' };
    case 'discord':
      return { __type: 'discord' };
    case 'slack':
      return { __type: 'slack' };
    default:
      return { __type: key || 'generic' };
  }
}
