FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production

# Tools needed at runtime:
# - tar/gzip for workspace bundle handling (already in slim, but explicit)
# - git: most coding agents need it
# - ca-certificates: outbound HTTPS
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tar gzip git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install pi globally so the runner can spawn it.
RUN npm install -g @mariozechner/pi-coding-agent

# Use the built-in `node` user (UID 1000) shipped with the node:* base image.
# Workspaces live under /data which is a mounted volume, so this user must own
# it at runtime (set up by the host or an entrypoint).
USER node
WORKDIR /home/node/app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
