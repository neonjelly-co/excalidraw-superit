FROM --platform=${BUILDPLATFORM} node:22 AS build

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --network-timeout 600000

ARG NODE_ENV=production

RUN npm_config_target_arch=${TARGETARCH} yarn build:app:docker

# Self-contained install of the runtime env injector for the nginx stage
RUN mkdir -p /opt/runtime-env \
    && cd /opt/runtime-env \
    && npm init -y >/dev/null \
    && npm install @import-meta-env/cli@0.7.4 --omit=dev

FROM --platform=${TARGETPLATFORM} nginx:1.27-alpine

RUN apk add --no-cache nodejs

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html
COPY --from=build /opt/node_app/.env.example /opt/.env.example
COPY --from=build /opt/runtime-env /opt/runtime-env
COPY docker/40-inject-runtime-env.sh /docker-entrypoint.d/40-inject-runtime-env.sh
RUN chmod +x /docker-entrypoint.d/40-inject-runtime-env.sh

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
