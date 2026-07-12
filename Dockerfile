# syntax=docker/dockerfile:1

# ---- Stage 1: server dependencies -----------------------------------------
# Installed with devDependencies so the `postinstall` (patch-package) step can
# apply patches/sdcp+0.5.4.patch to node_modules/sdcp, and so the `dev` stage
# below (which needs jest/supertest/vite etc.) can reuse this layer instead of
# repeating the apt-get/npm ci work.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# .npmrc carries legacy-peer-deps=true, needed because better-auth declares an
# optional better-sqlite3 ^12 peer while this repo pins 9.6.0; npm ci ERESOLVEs
# without it. It must be present before npm ci runs, not just in the repo.
COPY package.json package-lock.json .npmrc ./
COPY patches ./patches
RUN npm ci

# Pruned to production deps only — used by the `runtime` stage so jest/supertest/
# patch-package don't ship, while the patched files `npm ci` produced still do.
FROM deps AS server-deps
RUN npm prune --omit=dev

# ---- Stage 2: build the React client ---------------------------------------
FROM node:22-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json client/.npmrc ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Stage 3: production runtime -------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# gosu drops privileges cleanly in the entrypoint (see docker-entrypoint.sh);
# it is a tiny, purpose-built setuid helper packaged in Debian. A fixed uid/gid
# is used (not the base image's implicit "node" user) so it is explicit and
# matches any one-time volume chown documented in the deploy notes.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 farmapp \
    && useradd --uid 10001 --gid farmapp --shell /usr/sbin/nologin --no-create-home farmapp

COPY package.json ./
COPY --from=server-deps /app/node_modules ./node_modules
COPY server ./server
# Operational scripts (seed-admin, auth smoke) must ship in the production
# image: the first-admin seed runs inside the deployed container's terminal.
COPY scripts ./scripts
COPY --from=client-build /app/client/dist ./client/dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh

# Persistent state, mount volumes here in production (see docker-compose.yml).
# chown seeds ownership for a brand new empty volume; an already-populated
# root-owned volume is fixed at container start by the entrypoint instead.
RUN mkdir -p server/data server/gcode \
    && chown -R farmapp:farmapp server/data server/gcode

EXPOSE 3000

# Detect a hung-but-listening process (event loop wedged, no crash). Node's
# built-in fetch is used because bookworm-slim ships neither curl nor wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Entrypoint starts as root only to chown the volumes, then execs as farmapp.
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]

# ---- Stage 4: development -------------------------------------------------
# Not used for production — this backs the `dev`-profile service in
# docker-compose.yml, run on its own via
# `docker compose up --build print-farm-manager-dev` (name the service
# explicitly so it doesn't start alongside production — see that file's
# comment on this service for why `--profile dev` alone isn't enough). Full
# source is bind-mounted at runtime, not baked in here; this stage only
# provides dependencies (including devDependencies and client/node_modules) so
# the container starts without a local npm install and without the
# native-module (better-sqlite3) ABI mismatches that come from bind-mounting a
# macOS/Windows host's own node_modules into a Linux container. See
# docker-compose.yml's `dev` service for how node_modules is kept out of that
# bind mount.
FROM deps AS dev
WORKDIR /app
COPY client/package.json client/package-lock.json client/.npmrc ./client/
RUN npm ci --prefix client

EXPOSE 3000 5173

# server/index.js requires client/dist/index.html to exist (regardless of dev
# vs. production) even though nothing in the dev workflow actually serves from
# it — the browser talks to Vite on :5173, which proxies /api to :3000. Build
# once on first start if it's missing (e.g. a fresh clone bind-mounted in with
# no prior `npm run build`) so the container is usable without that manual
# step; skip it on subsequent starts since client/dist persists on the host
# via the bind mount. `&&`, not `;` — a broken build must stop here loudly
# instead of silently falling through into `npm run dev` with the server half
# of it doomed to crash on the same missing-dist check for a non-obvious reason.
CMD ["sh", "-c", "[ -f client/dist/index.html ] || npm run build && npm run dev"]
