# ---------------------------------------------------------------------------
# Multi-stage Dockerfile for the Creator Database backend.
# Stage 1 installs deps + builds; stage 2 ships a lean production image.
# ---------------------------------------------------------------------------

# --- Builder ---------------------------------------------------------------
FROM node:20-slim AS builder

# Prisma needs OpenSSL to generate/run its query engine.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and generate the Prisma client, then compile TypeScript.
COPY . .
RUN npx prisma generate
RUN npm run build

# Strip dev dependencies so we can copy a production-only node_modules.
RUN npm prune --omit=dev

# --- Runner ----------------------------------------------------------------
FROM node:20-slim AS runner

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Copy the compiled app, pruned deps, generated Prisma client, migrations and
# the static admin UI (served from ./public by src/main.ts).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

# Run as the built-in non-root user shipped with the node image.
USER node

EXPOSE 3000

# Boot the server directly. The app binds the HTTP port first (so the platform
# healthcheck is never blocked) and then runs `prisma migrate deploy` in the
# background from the CLI shipped in node_modules. See src/main.ts.
CMD ["node", "dist/main.js"]
