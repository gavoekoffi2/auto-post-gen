# The Pro Social AI API.
#
# Multi-stage so the shipped image carries the compiled output and the
# production dependencies only — no TypeScript, no test files, no dev
# toolchain. Nothing here bakes in configuration: every value the server needs
# arrives as an environment variable at run time (see .env.selfhosted.example),
# so the same image is valid on any host and an image layer can never leak a
# secret.

# ---- build -----------------------------------------------------------------
# Pinned to the Node the project declares in "engines". Alpine keeps the final
# image small; the build stage is discarded either way.
FROM node:22.18-alpine AS build

WORKDIR /app

# Dependencies first, so a source-only change does not re-run the install.
# `npm ci` — not `npm install` — so the build is reproducible from the
# lockfile and cannot silently pick up a newer transitive version.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The background-removal model that cuts out the poster character. Fetched
# from a pinned release and checked against a pinned SHA-256 — a corrupted or
# substituted file fails the build instead of being loaded. Not in git (44 MB).
COPY scripts/fetch-bg-model.mjs ./scripts/
RUN node scripts/fetch-bg-model.mjs /app/models/silueta.onnx

# Reinstall with dev dependencies pruned. The compiled output in dist/ is
# already produced, so TypeScript and the type packages have no reason to
# travel any further.
RUN npm ci --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22.18-alpine AS runtime

# No init wrapper is installed here. src/index.ts registers its own SIGTERM and
# SIGINT handlers and runs a real shutdown (stop accepting, drain the pool), so
# Node as PID 1 terminates correctly. Zombie reaping, if it is ever needed, is
# Docker's own `init: true` in the compose file — one less package in the image,
# and one less network fetch that can fail behind a restrictive proxy.
ENV NODE_ENV=production
WORKDIR /app

# Owned by the unprivileged user the image already provides. The application
# never needs to write inside /app: uploads go to MEDIA_ROOT, which is a
# mounted volume.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/models ./models
COPY --chown=node:node package.json ./
# Migrations are read from disk at run time by `node dist/src/migrate.js`.
COPY --chown=node:node migrations ./migrations

# The media volume is mounted here. Creating it with the right owner means the
# first upload works even when Docker creates an empty volume for it.
RUN mkdir -p /app/media && chown node:node /app/media

USER node

EXPOSE 8080

# Hits the API's own health route, so the check fails if Fastify has stopped
# serving — not merely if the container is still running.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
