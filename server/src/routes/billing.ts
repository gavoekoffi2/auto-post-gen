import type { FastifyInstance } from "fastify";
import { env } from "../lib/env.js";
import { requireTenant } from "../lib/tenant.js";
import { asObject, asUuid } from "../lib/validate.js";
import { loadEntitlement } from "../services/entitlement.js";
import {
  cancelOwnRequest,
  createRequest,
  listOwnRequests,
  paymentAccounts,
} from "../services/subscriptions.js";
import { hitRateLimit } from "../lib/rateLimit.js";

/** The customer's own subscription: status, where to pay, payment declarations. */
export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/subscription", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const [entitlement, requests] = await Promise.all([
      loadEntitlement(ctx.profileId),
      listOwnRequests(ctx.profileId),
    ]);
    return {
      entitlement,
      requests,
      paymentAccounts: paymentAccounts(),
      beneficiary: env.paymentBeneficiary,
    };
  });

  app.post("/subscription/requests", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    // A declaration emails the operator; bound how many a session can send.
    await hitRateLimit(`subscription-request:${ctx.profileId}`, 10, 3600);
    const body = asObject(request.body, "body");
    const created = await createRequest(ctx.profileId, body);
    return reply.code(201).send(created);
  });

  app.post("/subscription/requests/:id/cancel", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const id = asUuid((request.params as { id?: string }).id, "id");
    await cancelOwnRequest(ctx.profileId, id);
    return { ok: true };
  });
}
