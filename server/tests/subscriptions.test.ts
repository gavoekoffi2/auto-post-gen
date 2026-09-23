import test, { after, before } from "node:test";
import assert from "node:assert/strict";

// The subscription lifecycle, end to end, against a real Postgres and the
// real Fastify routes (via inject — no port is opened).
//
// What is pinned here cannot be checked by reading the code: that a signup
// really starts a trial, that an expired account is refused BEFORE any
// provider is called, that no user-facing route can extend a trial, that the
// database refuses double declarations, and that an approval grants the plan
// exactly once.
//
// Run with a migrated database (npm test builds first):
//   DATABASE_URL=postgres://... npm test

process.env.SESSION_COOKIE_SECRET ??= "test-secret-that-is-long-enough-for-the-check";
process.env.MEDIA_ROOT ??= "/tmp/psa-test-media";
process.env.NODE_ENV = "test";
// The weekly runner checks for a text provider before anything else, so a key
// must be present for it to reach its entitlement gate. It is never used:
// every call below is refused before any provider is contacted.
process.env.OPENROUTER_API_KEY ??= "test-key-never-sent";
// Email stays unconfigured: the flows must work without it.
delete process.env.RESEND_API_KEY;

const { default: Fastify } = await import("fastify");
const { default: cookie } = await import("@fastify/cookie");
const { pool, query, queryOne } = await import("../dist/src/lib/db.js");
const { HttpError } = await import("../dist/src/lib/errors.js");
const { authRoutes } = await import("../dist/src/routes/auth.js");
const { profileRoutes } = await import("../dist/src/routes/profile.js");
const { generationRoutes } = await import("../dist/src/routes/generations.js");
const { billingRoutes } = await import("../dist/src/routes/billing.js");
const { miscRoutes } = await import("../dist/src/routes/misc.js");
const { generateWeekFor } = await import("../dist/src/services/weekly.js");
const { addMonths, runSubscriptionReminders } = await import(
  "../dist/src/services/subscriptions.js"
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions walk arbitrary JSON bodies
type Json = Record<string, any>;

const app = Fastify();
await app.register(cookie, { secret: process.env.SESSION_COOKIE_SECRET });
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof HttpError) {
    return reply.code(error.status).send({ error: error.message, code: error.code });
  }
  return reply.code(500).send({ error: String(error) });
});
await app.register(
  async (scope) => {
    await authRoutes(scope);
    await profileRoutes(scope);
    await generationRoutes(scope);
    await billingRoutes(scope);
    await miscRoutes(scope);
  },
  { prefix: "/api" },
);

const stamp = Date.now();
const created: string[] = [];

async function signup(label: string, requestedPlan?: string): Promise<{ id: string; cookie: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.0.${created.length}.1`,
    payload: { email: `${label}-${stamp}@example.test`, password: "correct-horse-battery", requestedPlan },
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = (res.json() as Json).user.id as string;
  created.push(id);
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0]! : String(raw);
  return { id, cookie: header.split(";")[0]! };
}

const call = async (cookieHeader: string, method: "GET" | "POST" | "PATCH", url: string, payload?: Json) => {
  const res = await app.inject({ method, url, payload, headers: { cookie: cookieHeader } });
  return { status: res.statusCode, body: (res.body ? res.json() : {}) as Json };
};

let customer: { id: string; cookie: string };
let operator: { id: string; cookie: string };

before(async () => {
  customer = await signup("customer", "enterprise");
  operator = await signup("operator");
  await query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [operator.id]);
});

after(async () => {
  await query(`DELETE FROM profiles WHERE id = ANY($1)`, [created]);
  await app.close();
  await pool.end();
});

test("a signup starts a trial of the plan it asked for", async () => {
  const { status, body } = await call(customer.cookie, "GET", "/api/subscription");
  assert.equal(status, 200);
  assert.equal(body.entitlement.state, "trialing");
  assert.equal(body.entitlement.plan, "enterprise");
  assert.equal(body.entitlement.daysLeft, 7);
  assert.equal(body.entitlement.canGenerate, true);

  // Anything unexpected falls back to Pro rather than to a plan we do not sell.
  const other = await signup("weird-plan", "platinum");
  const res = await call(other.cookie, "GET", "/api/subscription");
  assert.equal(res.body.entitlement.plan, "pro");
});

test("no user-facing route can extend a trial or grant a plan", async () => {
  const res = await call(customer.cookie, "PATCH", "/api/profile", {
    plan: "enterprise",
    subscription_status: "active",
    trial_ends_at: "2099-01-01T00:00:00Z",
    current_period_ends_at: "2099-01-01T00:00:00Z",
    company_name: "Boutique Test",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = await queryOne<{ plan: string; subscription_status: string; trial_ends_at: Date; company_name: string }>(
    `SELECT plan, subscription_status, trial_ends_at, company_name FROM profiles WHERE id = $1`,
    [customer.id],
  );
  assert.equal(row!.company_name, "Boutique Test", "the allowed field is written");
  assert.equal(row!.plan, "starter");
  assert.equal(row!.subscription_status, "trialing");
  assert.ok(row!.trial_ends_at.getTime() < Date.now() + 8 * 86_400_000, "the trial end did not move");
});

test("an expired account is refused new content before any provider is called", async () => {
  const expired = await signup("expired");
  await query(`UPDATE profiles SET trial_ends_at = now() - interval '1 minute' WHERE id = $1`, [expired.id]);

  const text = await call(expired.cookie, "POST", "/api/generations/text", { platforms: ["LinkedIn"] });
  assert.equal(text.status, 402);
  assert.equal(text.body.code, "subscription_expired");
  assert.match(text.body.error, /posts déjà programmés continuent d'être publiés/);

  // No quota was consumed by the refusal.
  const used = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM generation_usage WHERE profile_id = $1`,
    [expired.id],
  );
  assert.equal(used!.n, 0);

  // The weekly runner skips it too.
  const weekly = await generateWeekFor(expired.id);
  assert.equal(weekly.generated, 0);
  assert.equal(weekly.skipped, "subscription_expired");

  // And the Enterprise-only auto-reply cannot be switched on.
  await call(expired.cookie, "PATCH", "/api/profile", { auto_reply_enabled: true });
  const flag = await queryOne<{ auto_reply_enabled: boolean }>(
    `SELECT auto_reply_enabled FROM profiles WHERE id = $1`,
    [expired.id],
  );
  assert.equal(flag!.auto_reply_enabled, false);
});

test("the plan's monthly ceiling is enforced server-side", async () => {
  const starter = await signup("starter-cap", "starter");
  // Fill the Starter monthly text allowance (60) with past usage.
  await query(
    `INSERT INTO generation_usage (profile_id, function_name, status, created_at)
     SELECT $1, 'generate-text', 'reserved', now() - interval '2 days'
       FROM generate_series(1, 60)`,
    [starter.id],
  );
  const res = await call(starter.cookie, "POST", "/api/generations/text", { platforms: ["LinkedIn"] });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "plan_limit_reached");
  assert.match(res.body.error, /Starter/);
});

test("a payment declaration is priced by the server and cannot be duplicated", async () => {
  const declared = await call(customer.cookie, "POST", "/api/subscription/requests", {
    plan: "enterprise",
    billingPeriod: "annual",
    paymentMethod: "orange_money",
    payerPhone: "+225 07 12 34 56 78",
    paymentReference: "MP230923.0001.X99",
    // Ignored: the amount is never read from the request.
    amount_fcfa: 1,
    amountFcfa: 1,
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
  assert.equal(declared.body.request.amount_fcfa, 29000 * 12);
  assert.equal(declared.body.request.status, "pending");
  assert.equal(declared.body.operatorNotified, false, "email is optional");

  // A second pending declaration from the same account is refused…
  const second = await call(customer.cookie, "POST", "/api/subscription/requests", {
    plan: "pro", billingPeriod: "monthly", paymentMethod: "wave",
    payerPhone: "+225 07 12 34 56 78", paymentReference: "W_ANOTHER1",
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "pending_exists");

  // …and so is someone else reusing the same reference (case-insensitive).
  const other = await signup("ref-thief");
  const reused = await call(other.cookie, "POST", "/api/subscription/requests", {
    plan: "pro", billingPeriod: "monthly", paymentMethod: "orange_money",
    payerPhone: "+225 01 02 03 04 05", paymentReference: "mp230923.0001.x99",
  });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, "duplicate_reference");

  // Declaring grants nothing.
  const state = await call(customer.cookie, "GET", "/api/subscription");
  assert.equal(state.body.entitlement.state, "trialing");
  assert.equal(state.body.requests.length, 1);
});

test("only an operator can decide a payment, and an approval grants the plan exactly once", async () => {
  const pending = await queryOne<{ id: string }>(
    `SELECT id FROM subscription_requests WHERE profile_id = $1 AND status = 'pending'`,
    [customer.id],
  );

  const forbidden = await call(customer.cookie, "POST", "/api/admin/actions", {
    action: "approve_subscription", requestId: pending!.id,
  });
  assert.equal(forbidden.status, 403);

  const approved = await call(operator.cookie, "POST", "/api/admin/actions", {
    action: "approve_subscription", requestId: pending!.id,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const again = await call(operator.cookie, "POST", "/api/admin/actions", {
    action: "approve_subscription", requestId: pending!.id,
  });
  assert.equal(again.status, 409, "a decided payment cannot be granted twice");

  const state = await call(customer.cookie, "GET", "/api/subscription");
  assert.equal(state.body.entitlement.state, "active");
  assert.equal(state.body.entitlement.plan, "enterprise");
  const daysLeft = state.body.entitlement.daysLeft as number;
  assert.ok(daysLeft >= 364 && daysLeft <= 366, `an annual payment runs a year (got ${daysLeft})`);
});

test("a rejected or cancelled declaration frees its reference", async () => {
  const account = await signup("rejected");
  const declare = (reference: string) =>
    call(account.cookie, "POST", "/api/subscription/requests", {
      plan: "starter", billingPeriod: "monthly", paymentMethod: "wave",
      payerPhone: "+221 77 000 00 00", paymentReference: reference,
    });

  const first = await declare("W_TYPO1234");
  assert.equal(first.status, 201);
  const rejected = await call(operator.cookie, "POST", "/api/admin/actions", {
    action: "reject_subscription", requestId: first.body.request.id, note: "Référence introuvable",
  });
  assert.equal(rejected.status, 200);
  assert.equal((await declare("W_TYPO1234")).status, 201, "the same reference can be declared again");

  const list = await call(account.cookie, "GET", "/api/subscription");
  const pendingId = list.body.requests.find((r: Json) => r.status === "pending").id;
  const cancelled = await call(account.cookie, "POST", `/api/subscription/requests/${pendingId}/cancel`);
  assert.equal(cancelled.status, 200);
  const cancelAgain = await call(account.cookie, "POST", `/api/subscription/requests/${pendingId}/cancel`);
  assert.equal(cancelAgain.status, 409);
});

test("an operator can grant a plan by hand and extend a trial", async () => {
  const lapsed = await signup("lapsed");
  await query(
    `UPDATE profiles SET subscription_status = 'active', plan = 'pro',
            current_period_ends_at = now() - interval '1 day' WHERE id = $1`,
    [lapsed.id],
  );
  assert.equal((await call(lapsed.cookie, "GET", "/api/subscription")).body.entitlement.state, "expired");
  await call(operator.cookie, "POST", "/api/admin/actions", { action: "set_plan", userId: lapsed.id, plan: "starter" });
  const granted = (await call(lapsed.cookie, "GET", "/api/subscription")).body.entitlement;
  assert.equal(granted.state, "active", "a plan set by hand is active, not left expired");
  assert.equal(granted.endsAt, null);

  const prospect = await signup("prospect");
  await query(`UPDATE profiles SET trial_ends_at = now() - interval '2 days' WHERE id = $1`, [prospect.id]);
  const extended = await call(operator.cookie, "POST", "/api/admin/actions", {
    action: "extend_trial", userId: prospect.id, days: 7,
  });
  assert.equal(extended.status, 200);
  const reopened = (await call(prospect.cookie, "GET", "/api/subscription")).body.entitlement;
  assert.equal(reopened.state, "trialing");
  assert.equal(reopened.daysLeft, 7, "counted from now for an expired trial");

  const refused = await call(operator.cookie, "POST", "/api/admin/actions", {
    action: "extend_trial", userId: prospect.id, days: 365,
  });
  assert.equal(refused.status, 400);
});

test("pre-existing accounts are active and open-ended, never expired by the deploy", async () => {
  // Every row the backfill touched has no trial end date; none may be trialing.
  const stuck = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM profiles WHERE subscription_status = 'trialing' AND trial_ends_at IS NULL`,
  );
  assert.equal(stuck!.n, 0);
});

test("renewal arithmetic keeps the calendar day and never overflows a month", () => {
  assert.equal(addMonths(new Date("2026-01-31T10:00:00Z"), 1).toISOString(), "2026-02-28T10:00:00.000Z");
  assert.equal(addMonths(new Date("2028-01-31T10:00:00Z"), 1).toISOString(), "2028-02-29T10:00:00.000Z");
  assert.equal(addMonths(new Date("2026-03-15T10:00:00Z"), 12).toISOString(), "2027-03-15T10:00:00.000Z");
});

test("reminders need email and say so instead of pretending", async () => {
  const result = await runSubscriptionReminders();
  assert.deepEqual(result, { sent: 0, failed: 0, skipped: "email_not_configured" });
});
