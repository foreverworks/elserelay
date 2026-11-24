# node:26-slim is Node 26.13.1 (active LTS), pinned by the digest of its multi-arch index,
# read from the registry on 2026-11-24. Move the digest on purpose, never by a floating tag.
ARG NODE_IMAGE=node:26-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    ELSERELAY_CONFIG=/data/config.json \
    ELSERELAY_HEALTH_URL=http://127.0.0.1:7411/healthz
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /src/dist ./dist
# One writable place: the config, the SQLite file, the tokens and the state of the adapter and of an approver.
# The root file system may be read-only (docker run --read-only).
RUN mkdir /data && chown 10001:10001 /data
ENV HOME=/data
VOLUME /data
USER 10001:10001
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["broker"]
# The broker's adapter port answers /healthz; change the variable if the config uses another port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "/app/dist/cli.js", "health"]
