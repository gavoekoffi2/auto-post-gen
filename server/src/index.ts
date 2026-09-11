import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { env, missingCapabilities } from "./lib/env.js";
import { HttpError } from "./lib/errors.js";
import { MAX_UPLOAD_BYTES } from "./lib/media.js";
import { pool } from "./lib/db.js";
import { authRoutes } from "./routes/auth.js";
import { profileRoutes } from "./routes/profile.js";
import { postRoutes } from "./routes/posts.js";
import { mediaRoutes } from "./routes/media.js";
import { generationRoutes } from "./routes/generations.js";
import { miscRoutes } from "./routes/misc.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";

const app = Fastify({
  logger: { level: env.isProduction ? "info" : "debug" },
  // nginx terminates TLS and forwards, so the socket peer is always the
  // proxy. This is what makes request.ip the real client — and why no route
  // reads a raw X-Forwarded-For header itself, which any client can set.
  trustProxy: true,
  bodyLimit: 1024 * 1024,
});

await app.register(cookie, { secret: env.sessionSecret });
await app.register(multipart, {
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 10,
  },
});

// No CORS plugin, deliberately.
//
// The dashboard is served from the same origin and calls relative /api paths,
// so cross-origin requests are never legitimate here. Registering CORS would
// only create a way to get this wrong.

app.setErrorHandler((error, request, reply) => {
  if (error instanceof HttpError) {
    return reply
      .code(error.status)
      .send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  }

  // Fastify's own validation and payload errors carry a usable status.
  const status = (error as { statusCode?: number }).statusCode ?? 500;
  if (status === 413) {
    return reply.code(413).send({ error: "Le fichier envoyé est trop volumineux." });
  }
  if (status >= 400 && status < 500) {
    return reply.code(status).send({ error: "Requête invalide." });
  }

  // Anything unexpected is logged in full and answered generically: an error
  // body is where a server leaks its internals if you let it.
  request.log.error({ err: error }, "unhandled error");
  return reply
    .code(500)
    .send({ error: "Le serveur a rencontré une erreur. Réessayez dans un instant." });
});

app.setNotFoundHandler((_request, reply) => {
  reply.code(404).send({ error: "Ressource introuvable.", code: "not_found" });
});

// Everything is mounted under /api, which is what nginx proxies.
await app.register(
  async (scope) => {
    await authRoutes(scope);
    await profileRoutes(scope);
    await postRoutes(scope);
    await mediaRoutes(scope);
    await generationRoutes(scope);
    await miscRoutes(scope);
  },
  { prefix: "/api" },
);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  try {
    stopScheduler();
    await app.close();
    await pool.end();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Unconfigured capabilities are reported once at boot, and again — in the
// same words — by the route that needs them, so a user never meets a silent
// no-op and an operator can see what is missing from the logs alone.
for (const missing of missingCapabilities()) {
  app.log.warn(`capability unavailable: ${missing}`);
}

// Scheduled publishing needs something to run it. An interval in this
// process is enough for a single-container deployment, and safe with more
// than one: each post is claimed with a conditional UPDATE, so runners racing
// on the same post cannot both publish it. Set PUBLISH_TICK_SECONDS=0 to turn
// it off and drive the queue from the host's own scheduler instead, via
// POST /api/cron/publish with CRON_SECRET.
const tickSeconds = Number(process.env.PUBLISH_TICK_SECONDS ?? 60);
if (Number.isFinite(tickSeconds) && tickSeconds > 0) {
  startScheduler(tickSeconds * 1000, (message) => app.log.info(message));
  app.log.info(`publish queue runner started (every ${tickSeconds}s)`);
} else {
  app.log.warn("publish queue runner disabled (PUBLISH_TICK_SECONDS=0)");
}

await app.listen({ port: env.port, host: env.host });
