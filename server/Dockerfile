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

# Non-root user. Workspaces live under /data which is a mounted volume,
# so this user must own it at runtime (set up by the host or an entrypoint).
RUN useradd -m -u 1000 -s /bin/bash pi
USER pi
WORKDIR /home/pi/app

COPY --from=build --chown=pi:pi /app/node_modules ./node_modules
COPY --from=build --chown=pi:pi /app/dist ./dist
COPY --chown=pi:pi package.json ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
