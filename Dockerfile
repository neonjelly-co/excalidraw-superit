FROM --platform=${BUILDPLATFORM} node:24@sha256:8530f76a96d88820d288761f022e318970dda93d01536919fbc16076b7983e63 AS build

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --frozen-lockfile --network-timeout 600000

ARG NODE_ENV=production

RUN npm_config_target_arch=${TARGETARCH} yarn build:app:docker

# Self-contained install of the runtime env injector for the nginx stage
RUN mkdir -p /opt/runtime-env \
    && cd /opt/runtime-env \
    && npm init -y >/dev/null \
    && npm install @import-meta-env/cli@0.7.4 --omit=dev

FROM nginx:stable-alpine-slim@sha256:2c605dbeab79a6b2a63340474fe58119d0ef95bdc4b1f41df0aa689659b3d13b

RUN apk add --no-cache nodejs

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html
COPY --from=build /opt/node_app/.env.example /opt/.env.example
COPY --from=build /opt/runtime-env /opt/runtime-env
COPY docker/40-inject-runtime-env.sh /docker-entrypoint.d/40-inject-runtime-env.sh
RUN chmod +x /docker-entrypoint.d/40-inject-runtime-env.sh

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
