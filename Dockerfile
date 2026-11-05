FROM node:24.22.1-bookworm-slim AS build
WORKDIR /build
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY host ./host
COPY host-rust/install.py ./host-rust/install.py
COPY scripts/build-host-assets.mjs ./scripts/build-host-assets.mjs
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.source="https://github.com/firtoz/jetski"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production JETSKI_CONFIG=/etc/jetski/server.json
WORKDIR /opt/jetski
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY package.json LICENSE NOTICE ./
COPY --from=build /build/host ./host
COPY --from=build /build/host-rust/install.py ./host-rust/install.py
COPY scripts/container-health.mjs ./healthcheck.mjs
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "healthcheck.mjs"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--config", "/etc/jetski/server.json"]
