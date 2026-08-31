# Multi-stage so the runtime image never contains npm's build tooling or the
# dev dependency tree.
#
# No ffmpeg layer on purpose: FFMPEG_PATH is dead config. src/services/recording.js
# writes the 44-byte WAV header itself in pure JS, so nothing shells out to ffmpeg
# and the image stays small.

# ─── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# Copy manifests only, so this layer is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Node does not see cgroup memory limits by default and will happily grow past
# the container limit until the OOM killer takes it. Keep the heap under it.
ENV NODE_OPTIONS=--max-old-space-size=768

# dumb-init as PID 1: without it Node runs as PID 1 and does not get the default
# signal handlers, so SIGTERM can be ignored entirely — which would defeat the
# graceful drain in src/api/lifecycle.js and hang up every live call on deploy.
RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY sql ./sql

# The node image ships an unprivileged 'node' user. Run as it rather than root.
USER node

EXPOSE 3000

# Liveness only — /health checks no dependencies, so a Supabase blip cannot cause
# the orchestrator to kill every replica at once.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
