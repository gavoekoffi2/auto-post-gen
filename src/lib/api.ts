// Single entry point between the dashboard and the self-hosted API.
//
// Everything the frontend needs from the server goes through here. That is
// deliberate: the API contract lives in ONE file, so if the VPS backend's
// shapes differ from what is assumed here, only this file changes — not the
// twenty components that call it.
//
// Rules this module enforces, by construction:
//
//   * Same-origin only. Requests go to a relative "/api/..." path, proxied by
//     nginx to the API container. There is no configurable API base URL and no
//     build-time secret: nothing about the backend leaks into the bundle.
//   * `credentials: "include"`, because the session is an HttpOnly cookie the
//     browser cannot read. No token is ever stored in localStorage.
//   * The browser NEVER states who it is. No userId, profileId or tenant id is
//     sent as an argument; the server derives identity from the verified
//     session cookie. A client-supplied identity would be an authorisation
//     bypass, so the types here simply give callers no way to express one.
//   * Errors arrive as readable French messages (see ApiError), not as a raw
//     status code or an unhandled rejection.

/** Error carrying the server's message, its HTTP status and an optional code. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The session is missing or expired — callers redirect to /auth. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** The server refused this action for this account. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** A quota or rate limit was hit; the message says which. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

const API_ROOT = "/api";

/** Requests that carry no body still need a long-enough ceiling for AI work. */
const DEFAULT_TIMEOUT_MS = 30_000;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Overall ceiling for this call; AI generation passes a larger one. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Sent as-is (FormData); the browser sets the multipart boundary itself. */
  formData?: FormData;
}

function humanMessage(status: number, payload: unknown, fallbackText: string): string {
  if (payload && typeof payload === "object") {
    const body = payload as { error?: unknown; message?: unknown };
    const candidate = typeof body.error === "string"
      ? body.error
      : typeof body.message === "string"
      ? body.message
      : "";
    if (candidate.trim()) return candidate;
  }
  if (fallbackText.trim() && fallbackText.length < 300) return fallbackText;
  // No usable server message: say something the user can act on rather than
  // surfacing a bare status code.
  if (status === 401) return "Votre session a expiré. Reconnectez-vous.";
  if (status === 403) return "Vous n'avez pas accès à cette ressource.";
  if (status === 404) return "Ressource introuvable.";
  if (status === 409) return "Cette action entre en conflit avec l'état actuel.";
  if (status === 413) return "Le fichier envoyé est trop volumineux.";
  if (status === 429) return "Trop de requêtes. Réessayez dans un moment.";
  if (status >= 500) return "Le serveur a rencontré une erreur. Réessayez dans un instant.";
  return `La requête a échoué (${status}).`;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, formData, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Honour a caller's own cancellation alongside the timeout.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  let payload: BodyInit | undefined;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers,
      body: payload,
      // The session cookie is HttpOnly, so it only travels if we ask for it.
      credentials: "include",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new ApiError(
        "Le serveur met trop de temps à répondre. Réessayez dans un instant.",
        408,
        "timeout",
      );
    }
    throw new ApiError(
      "Impossible de joindre le serveur. Vérifiez votre connexion.",
      0,
      "network",
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const code = parsed && typeof parsed === "object"
      ? (parsed as { code?: unknown }).code
      : undefined;
    throw new ApiError(
      humanMessage(response.status, parsed, text),
      response.status,
      typeof code === "string" ? code : undefined,
      parsed,
    );
  }

  return (parsed ?? (undefined as unknown)) as T;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  role: "user" | "admin" | "super_admin";
  createdAt: string;
}

export type PostStatus = "pending" | "validated" | "publishing" | "published" | "failed";
export type ContentCategory = "value" | "research" | "promo";

export interface AudienceSegmentPayload {
  id: string;
  name: string;
  description: string;
  pain_points: string[];
  goals: string[];
  content_topics: string[];
  buying_triggers: string[];
  preferred_tone?: string;
  priority?: number;
}

export interface Profile {
  id: string;
  email: string;
  company_name: string | null;
  sector: string | null;
  description: string | null;
  tone: string | null;
  content_types: string[];
  post_frequency: number;
  platforms: string[];
  preferred_days: string[];
  preferred_time: string;
  promo_posts_per_week: number;
  research_posts_per_week: number;
  auto_publish: boolean;
  style_example: string | null;
  style_examples: Array<{ label?: string; content: string }>;
  image_people_type: string | null;
  image_style: string | null;
  use_custom_images: boolean;
  custom_image_urls: string[];
  brand_primary_color: string | null;
  brand_secondary_color: string | null;
  brand_accent_color: string | null;
  brand_font: string | null;
  logo_url: string | null;
  poster_footer_text: string | null;
  audience_suggestions: AudienceSegmentPayload[];
  target_audiences: AudienceSegmentPayload[];
  audiences_confirmed_at: string | null;
  auto_reply_enabled: boolean;
  auto_reply_instructions: string | null;
  plan: string;
  /** Set by the user before any photo of a real person may be sent to the
   *  image provider. Never inferred; see consent handling in the UI. */
  leader_photo_consent_at: string | null;
}

export interface Post {
  id: string;
  title: string;
  content: string;
  content_category: ContentCategory | null;
  platforms: string[];
  status: PostStatus;
  scheduled_for: string | null;
  published_at: string | null;
  image_url: string | null;
  image_status: "processing" | "done" | "failed" | null;
  image_job_id: string | null;
  publish_error: string | null;
  publish_attempts: number;
  external_post_ids: Record<string, string>;
  created_at: string;
}

export interface MediaAsset {
  id: string;
  url: string;
  kind: "logo" | "custom_image" | "poster" | "other";
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface SocialAccount {
  id: string;
  platform: string;
  username: string | null;
  display_name: string | null;
  is_active: boolean;
  connected_at: string;
}

export interface SocialComment {
  id: string;
  post_id: string | null;
  platform: string;
  external_comment_id: string;
  author_name: string | null;
  author_handle: string | null;
  message: string | null;
  status: "new" | "replied" | "ignored" | "hidden";
  reply_text: string | null;
  /** Whether the stored reply was written by the user or by the auto-replier. */
  replied_by: "manual" | "auto" | null;
  comment_created_at: string | null;
  created_at: string;
}

/**
 * A generation job. Poster generation can take minutes, so the server answers
 * `processing` with a job id and the client re-polls — re-polling reads an
 * existing job and never starts (or bills) a second generation.
 */
export interface GenerationJob {
  jobId: string;
  status: "processing" | "completed" | "failed";
  kind: "image" | "video";
  /** Present only when status is "completed". */
  url?: string;
  /** Present only when status is "failed": the provider's real reason. */
  error?: string;
  format?: { label: string; aspectRatio: string; resolution: string };
}

export interface TextGeneration {
  content: string;
  postType: ContentCategory;
  angle: string;
  usedWebInspiration: boolean;
  /** True when the provider was unreachable and this is canned filler text. */
  fallback?: boolean;
  textLimit?: { platform: string; label: string; maxChars: number };
}

export interface PublishResult {
  platform: string;
  status: "ok" | "pending" | "error" | "not_connected";
  message?: string;
  externalUrl?: string;
}

// ---------------------------------------------------------------------------
// Auth — the session is an HttpOnly cookie set and cleared by the server.
// ---------------------------------------------------------------------------

export const auth = {
  register: (email: string, password: string) =>
    request<{ user: SessionUser }>("/auth/register", {
      method: "POST",
      body: { email, password },
    }),

  login: (email: string, password: string) =>
    request<{ user: SessionUser }>("/auth/login", {
      method: "POST",
      body: { email, password },
    }),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  /** Current session, or null when there is none. Never throws on 401. */
  async me(): Promise<SessionUser | null> {
    try {
      const { user } = await request<{ user: SessionUser }>("/auth/me");
      return user;
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthenticated) return null;
      throw err;
    }
  },

  requestPasswordReset: (email: string) =>
    request<{ ok: true }>("/auth/password-reset/request", {
      method: "POST",
      body: { email },
    }),

  /** Completes a reset with the token from the emailed link. */
  resetPassword: (token: string, password: string) =>
    request<{ ok: true }>("/auth/password-reset/confirm", {
      method: "POST",
      body: { token, password },
    }),

  /** Changing your own password requires the current one. */
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/auth/password", {
      method: "PATCH",
      body: { currentPassword, newPassword },
    }),
};

// ---------------------------------------------------------------------------
// Profile & onboarding
// ---------------------------------------------------------------------------

export const profile = {
  get: () => request<Profile>("/profile"),
  update: (patch: Partial<Profile>) =>
    request<Profile>("/profile", { method: "PATCH", body: patch }),

  /** AI segmentation of the business into target audiences. */
  detectAudiences: () =>
    request<{ audiences: AudienceSegmentPayload[] }>("/profile/audiences/detect", {
      method: "POST",
      timeoutMs: 90_000,
    }),

  /** Records explicit consent before any photo of a real person is sent to
   *  the image provider. Revocable by passing false. */
  setLeaderPhotoConsent: (granted: boolean) =>
    request<Profile>("/profile/leader-photo-consent", {
      method: "POST",
      body: { granted },
    }),
};

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

export const posts = {
  list: () => request<{ posts: Post[] }>("/posts"),
  create: (input: {
    title: string;
    content: string;
    platforms: string[];
    contentCategory?: ContentCategory;
    scheduledFor?: string | null;
    imageUrl?: string | null;
  }) => request<Post>("/posts", { method: "POST", body: input }),

  update: (
    id: string,
    patch: Partial<
      Pick<Post, "title" | "content" | "platforms" | "scheduled_for" | "status" | "image_url">
    >,
  ) => request<Post>(`/posts/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),

  remove: (id: string) =>
    request<void>(`/posts/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Marks a post approved and clears any retry backoff from a past failure. */
  validate: (id: string) =>
    request<Post>(`/posts/${encodeURIComponent(id)}/validate`, { method: "POST" }),

  publish: (id: string) =>
    request<{ results: PublishResult[]; post: Post }>(
      `/posts/${encodeURIComponent(id)}/publish`,
      { method: "POST", timeoutMs: 120_000 },
    ),

  /** Validation from the emailed one-time link; no session required. */
  validateByToken: (token: string) =>
    request<{ ok: true; postId: string }>("/posts/validate-by-token", {
      method: "POST",
      body: { token },
    }),

  statistics: () =>
    request<{
      totalPosts: number;
      publishedPosts: number;
      pendingPosts: number;
      validatedPosts: number;
      postsThisWeek: number;
      postsThisMonth: number;
      weekly: Array<{ name: string; posts: number }>;
      platforms: Array<{ name: string; value: number }>;
    }>("/posts/statistics"),
};

// ---------------------------------------------------------------------------
// Media — stored in the API's local volume, served back by the API.
// ---------------------------------------------------------------------------

export const media = {
  list: (kind?: MediaAsset["kind"]) =>
    request<{ media: MediaAsset[] }>(`/media${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`),

  upload: (file: File, kind: MediaAsset["kind"]) => {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    return request<MediaAsset>("/media", { method: "POST", formData: form, timeoutMs: 120_000 });
  },

  remove: (id: string) =>
    request<void>(`/media/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// Generation — providers stay server-side; no key ever reaches the browser.
// ---------------------------------------------------------------------------

export const generations = {
  /** Editorial text. Fast enough to answer in one call. */
  text: (input: { prompt?: string; platforms: string[]; postId?: string }) =>
    request<TextGeneration>("/generations/text", {
      method: "POST",
      body: input,
      timeoutMs: 120_000,
    }),

  /**
   * Starts a poster. A premium render can take minutes, so the server answers
   * `processing` with a job id rather than holding the connection open.
   */
  image: (input: { postId: string; platforms: string[]; contentCategory?: ContentCategory }) =>
    request<GenerationJob>("/generations/image", {
      method: "POST",
      body: input,
      timeoutMs: 120_000,
    }),

  video: (input: { postId: string; prompt?: string }) =>
    request<GenerationJob>("/generations/video", {
      method: "POST",
      body: input,
      timeoutMs: 120_000,
    }),

  /**
   * Reads an existing job. This is a pure status read: it never starts, and
   * never bills, a second generation — which is what makes it safe to resume a
   * job after a page reload or a client timeout.
   */
  status: (jobId: string) =>
    request<GenerationJob>(`/generations/${encodeURIComponent(jobId)}`, { timeoutMs: 60_000 }),
};

// ---------------------------------------------------------------------------
// Social accounts, comments, admin, account lifecycle
// ---------------------------------------------------------------------------

export const social = {
  listAccounts: () => request<{ accounts: SocialAccount[]; provisioned: boolean }>("/social/accounts"),
  /** Returns the provider URL the user opens to authorise a network. */
  connect: (platform: string) =>
    request<{ connectUrl: string; platform: string }>("/social/connect", {
      method: "POST",
      body: { platform },
      timeoutMs: 60_000,
    }),
  disconnect: (accountId: string) =>
    request<void>(`/social/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" }),
};

export const comments = {
  list: (filter?: "all" | "new" | "replied") =>
    request<{ comments: SocialComment[] }>(
      `/comments${filter && filter !== "all" ? `?status=${filter}` : ""}`,
    ),
  sync: () =>
    request<{ fetched: number; inserted: number }>("/comments/sync", {
      method: "POST",
      timeoutMs: 120_000,
    }),
  draftReply: (commentId: string) =>
    request<{ reply: string }>(`/comments/${encodeURIComponent(commentId)}/draft`, {
      method: "POST",
      timeoutMs: 60_000,
    }),
  reply: (commentId: string, reply: string) =>
    request<SocialComment>(`/comments/${encodeURIComponent(commentId)}/reply`, {
      method: "POST",
      body: { reply },
      timeoutMs: 60_000,
    }),
  setStatus: (commentId: string, status: SocialComment["status"]) =>
    request<SocialComment>(`/comments/${encodeURIComponent(commentId)}`, {
      method: "PATCH",
      body: { status },
    }),
};

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  blocked: boolean;
  companyName: string | null;
  createdAt: string;
  lastSignInAt: string | null;
}

export const admin = {
  /** Whether the CURRENT session is an admin. Authority is the server's. */
  me: () => request<{ user: SessionUser }>("/admin/me"),

  /**
   * Small action RPC for the operator console: { action, ...args }.
   *
   * The `userId` in an action names the account being ACTED ON, which is a
   * legitimate argument. It is never an assertion about who is calling: the
   * server re-derives the caller from the session cookie and refuses the whole
   * request unless that caller holds an admin role.
   */
  action: <T = unknown>(body: Record<string, unknown>) =>
    request<T>("/admin/actions", { method: "POST", body, timeoutMs: 60_000 }),
};

export const account = {
  /** Full export of the account's own data (GDPR). */
  exportData: () => request<Record<string, unknown>>("/account/export", { timeoutMs: 120_000 }),
  /** Irreversible. The server clears the session cookie as part of this. */
  remove: (password: string) =>
    request<void>("/account", { method: "DELETE", body: { password }, timeoutMs: 60_000 }),
};

export const contact = {
  send: (input: { name: string; email: string; subject: string; message: string; company?: string }) =>
    request<{ ok: true }>("/contact", { method: "POST", body: input }),
};

export const health = () => request<{ ok: boolean }>("/health");

/** Grouped default export so callers can write `api.posts.list()`. */
export const api = {
  auth,
  profile,
  posts,
  media,
  generations,
  social,
  comments,
  admin,
  account,
  contact,
  health,
};

export default api;
