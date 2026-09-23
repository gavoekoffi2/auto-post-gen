import test, { after, before } from "node:test";
import assert from "node:assert/strict";

// The operator console against the real routes and a real Postgres.
//
// The page (src/pages/Admin.tsx) and this API had drifted: the overview
// returned rows the page did not expect, so the console crashed on first
// render, and three of its buttons called actions that did not exist. These
// pin the contract and the protections around it.

process.env.SESSION_COOKIE_SECRET ??= "test-secret-that-is-long-enough-for-the-check";
process.env.MEDIA_ROOT ??= "/tmp/psa-test-media";
process.env.NODE_ENV = "test";

const { default: Fastify } = await import("fastify");
const { default: cookie } = await import("@fastify/cookie");
const { pool, query, queryOne } = await import("../dist/src/lib/db.js");
const { HttpError } = await import("../dist/src/lib/errors.js");
const { authRoutes } = await import("../dist/src/routes/auth.js");
const { miscRoutes } = await import("../dist/src/routes/misc.js");
const { billingRoutes } = await import("../dist/src/routes/billing.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions walk arbitrary JSON bodies
type Json = Record<string, any>;

const app = Fastify();
await app.register(cookie, { secret: process.env.SESSION_COOKIE_SECRET });
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message, code: error.code });
  return reply.code(500).send({ error: String(error) });
});
await app.register(async (scope) => {
  await authRoutes(scope);
  await miscRoutes(scope);
  await billingRoutes(scope);
}, { prefix: "/api" });

const stamp = Date.now();
const created: string[] = [];
let ip = 0;

async function signup(label: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.9.${ip++}.1`,
    payload: { email: `${label}-${stamp}@example.test`, password: "correct-horse-battery" },
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = (res.json() as Json).user.id as string;
  created.push(id);
  const raw = res.headers["set-cookie"];
  return { id, cookie: (Array.isArray(raw) ? raw[0]! : String(raw)).split(";")[0]! };
}

const act = async (cookieHeader: string, payload: Json) => {
  const res = await app.inject({ method: "POST", url: "/api/admin/actions", payload, headers: { cookie: cookieHeader } });
  return { status: res.statusCode, body: res.json() as Json };
};

let admin: { id: string; cookie: string };
let owner: { id: string; cookie: string };
let customer: { id: string; cookie: string };

before(async () => {
  admin = await signup("admin");
  owner = await signup("owner");
  customer = await signup("customer");
  await query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [admin.id]);
  await query(`UPDATE profiles SET role = 'super_admin' WHERE id = $1`, [owner.id]);
});

after(async () => {
  await query(`DELETE FROM profiles WHERE id = ANY($1) OR email LIKE $2`, [created, `%-${stamp}@example.test`]);
  await app.close();
  await pool.end();
});

test("the overview has the shape the console renders", async () => {
  const { status, body } = await act(admin.cookie, { action: "overview" });
  assert.equal(status, 200);
  const row = body.users.find((u: Json) => u.id === customer.id);
  assert.ok(row, "the customer is listed");
  assert.equal(typeof row.posts.total, "number");
  assert.equal(typeof row.posts.published, "number");
  assert.equal(typeof row.generations, "number");
  assert.equal(typeof row.connections, "number");
  assert.equal(row.profile.subscription_status, "trialing");
  assert.ok(row.profile.trial_ends_at);
  assert.equal(row.protectedOwner, false);
  // An admin cannot act on the owner, and nobody on themselves.
  assert.equal(body.users.find((u: Json) => u.id === owner.id).protectedOwner, true);
  assert.equal(body.users.find((u: Json) => u.id === admin.id).protectedOwner, true);
  for (const key of ["users", "active", "blocked", "admins", "posts", "published", "generations", "connections", "pendingSubscriptions"]) {
    assert.equal(typeof body.stats[key], "number", `stats.${key}`);
  }
});

test("a customer cannot reach the console", async () => {
  assert.equal((await act(customer.cookie, { action: "overview" })).status, 403);
});

test("create_user: a trial by default, a granted plan when one is given", async () => {
  const trial = await act(admin.cookie, {
    action: "create_user", email: `made-trial-${stamp}@example.test`, password: "long-enough-pw", plan: "", role: "user",
  });
  assert.equal(trial.status, 200, JSON.stringify(trial.body));
  const comped = await act(admin.cookie, {
    action: "create_user", email: `made-comped-${stamp}@example.test`, password: "long-enough-pw",
    plan: "enterprise", companyName: "Agence Teranga", role: "user",
  });
  assert.equal(comped.status, 200);
  const rows = await query<{ email: string; plan: string; subscription_status: string; current_period_ends_at: Date | null; company_name: string | null }>(
    `SELECT email::text AS email, plan, subscription_status, current_period_ends_at, company_name
       FROM profiles WHERE id = ANY($1) ORDER BY email`,
    [[trial.body.id, comped.body.id]],
  );
  assert.deepEqual(rows.map((r) => [r.plan, r.subscription_status, r.current_period_ends_at, r.company_name]), [
    ["enterprise", "active", null, "Agence Teranga"],
    ["starter", "trialing", null, null],
  ]);

  const duplicate = await act(admin.cookie, {
    action: "create_user", email: `made-trial-${stamp}@example.test`, password: "long-enough-pw",
  });
  assert.equal(duplicate.status, 409);
  const escalation = await act(admin.cookie, {
    action: "create_user", email: `made-owner-${stamp}@example.test`, password: "long-enough-pw", role: "super_admin",
  });
  assert.equal(escalation.status, 400, "an admin cannot mint a super admin");
});

test("reset_password signs the account out and cannot target the owner", async () => {
  const before = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE profile_id = $1`, [customer.id]);
  assert.ok(before!.n > 0);
  const res = await act(admin.cookie, { action: "reset_password", userId: customer.id, password: "brand-new-password" });
  assert.equal(res.status, 200);
  const after = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE profile_id = $1`, [customer.id]);
  assert.equal(after!.n, 0);

  const login = await app.inject({
    method: "POST", url: "/api/auth/login", remoteAddress: "10.9.200.1",
    payload: { email: `customer-${stamp}@example.test`, password: "brand-new-password" },
  });
  assert.equal(login.statusCode, 200);

  const takeover = await act(admin.cookie, { action: "reset_password", userId: owner.id, password: "attacker-password" });
  assert.equal(takeover.status, 400);
});

test("an operator cannot lock themselves out or delete the owner", async () => {
  assert.equal((await act(admin.cookie, { action: "set_blocked", userId: admin.id, blocked: true })).status, 400);
  assert.equal((await act(admin.cookie, { action: "set_role", userId: admin.id, role: "user" })).status, 400);
  assert.equal((await act(owner.cookie, { action: "delete_user", userId: owner.id })).status, 400);
  assert.equal((await act(admin.cookie, { action: "delete_user", userId: owner.id })).status, 400);
});

test("delete_user removes the account and everything it owns", async () => {
  const doomed = await signup("doomed");
  await query(
    `INSERT INTO subscription_requests (profile_id, plan, billing_period, amount_fcfa, payment_method, payer_phone, payment_reference)
     VALUES ($1, 'pro', 'monthly', 15000, 'wave', '+225 07 00 00 00 00', $2)`,
    [doomed.id, `W_DOOMED_${stamp}`],
  );
  const res = await act(admin.cookie, { action: "delete_user", userId: doomed.id });
  assert.equal(res.status, 200);
  const left = await queryOne<{ n: number }>(
    `SELECT (SELECT count(*) FROM profiles WHERE id = $1) + (SELECT count(*) FROM subscription_requests WHERE profile_id = $1) AS n`,
    [doomed.id],
  );
  assert.equal(Number(left!.n), 0);
});
