import { query } from "../lib/db.js";
import { publishPost } from "./publish.js";

// The publish queue runner.
//
// Scheduled publishing is the product's central promise, so something has to
// actually run it. On Supabase that was a cron invoking an Edge Function; here
// it is an interval inside the API container, plus an operator-triggerable
// route (see routes/misc.ts) for a host that would rather drive it from its
// own scheduler.
//
// Running it in every replica is safe: publishPost claims each post with a
// conditional UPDATE (validated → publishing), so two runners racing on the
// same post means one claims it and the other sees nothing to do.

/** Bounded so one tick cannot hold the pool or run for an unbounded time. */
const BATCH_SIZE = 12;

export interface TickResult {
  recovered: number;
  attempted: number;
  published: number;
}

/**
 * Selects the posts that are due and publishes them.
 *
 * `next_publish_attempt_at <= now()` is what keeps a failing post from
 * refilling the batch on every tick: the queue is ordered oldest-first and
 * capped, so without the backoff predicate a handful of unpublishable posts
 * starve every newer post behind them.
 */
export async function runPublishTick(): Promise<TickResult> {
  // First, unstick anything a crash left mid-publish. A post that already
  // reached the provider is marked published rather than re-queued — posting
  // the same content twice is worse than not retrying.
  const recovered = await query<{ recover_stuck_publishing: number }>(
    `SELECT recover_stuck_publishing()`,
  );

  const due = await query<{ id: string; profile_id: string }>(
    `SELECT id, profile_id
       FROM posts
      WHERE status = 'validated'
        AND scheduled_for IS NOT NULL
        AND scheduled_for <= now()
        AND next_publish_attempt_at <= now()
      ORDER BY scheduled_for ASC
      LIMIT $1`,
    [BATCH_SIZE],
  );

  let published = 0;
  for (const post of due) {
    try {
      const results = await publishPost(post.profile_id, post.id);
      if (results.some((r) => r.status === "ok")) published++;
    } catch (err) {
      // One post's failure must not abandon the rest of the batch. The row
      // keeps its own error and its own backoff; the loop continues.
      console.error(`[scheduler] post ${post.id} failed:`, (err as Error).message);
    }
  }

  return {
    recovered: Number(recovered[0]?.recover_stuck_publishing ?? 0),
    attempted: due.length,
    published,
  };
}

let timer: NodeJS.Timeout | null = null;

/** Starts the in-process runner. Idempotent; a second call is ignored. */
export function startScheduler(intervalMs: number, log: (message: string) => void): void {
  if (timer) return;
  const tick = () => {
    runPublishTick()
      .then((result) => {
        if (result.attempted || result.recovered) {
          log(
            `publish tick: ${result.published}/${result.attempted} published, ` +
              `${result.recovered} recovered`,
          );
        }
      })
      .catch((err) => console.error("[scheduler] tick failed:", (err as Error).message));
  };
  // unref so a pending timer never holds the process open during shutdown.
  timer = setInterval(tick, intervalMs);
  timer.unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
