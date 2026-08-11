# syntax=docker/dockerfile:1.17.1@sha256:38387523653efa0039f8e1c89bb74a30504e76ee9f565e25c9a09841f9427b05

ARG GO_IMAGE=golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651
ARG NODE_IMAGE=node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
ARG PYTHON_IMAGE=python:3.11.15-slim-bookworm@sha256:b18992999dbe963a45a8a4da40ac2b1975be1a776d939d098c647482bcad5cba
ARG SOURCE_DATE_EPOCH=1786127940

FROM ${GO_IMAGE} AS native-build
ARG SOURCE_DATE_EPOCH
WORKDIR /src
COPY go.mod ./
COPY internal ./internal
COPY cmd ./cmd
COPY native ./native
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go test ./... \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w -buildid=' -o /out/flow-prime-supervisor ./cmd/flow-prime-supervisor \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w -buildid=' -o /out/flow-prime-kernel-proxy ./cmd/flow-prime-kernel-proxy \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w -buildid=' -o /out/flow-prime-python ./cmd/flow-prime-python \
    && cc -std=c11 -Wall -Wextra -Werror -O2 -fPIC -shared -Wl,-z,relro,-z,now -Wl,--build-id=none -o /out/flow-prime-node-hardening.so native/node-hardening.c \
    && touch --date="@${SOURCE_DATE_EPOCH}" /out/flow-prime-supervisor /out/flow-prime-kernel-proxy /out/flow-prime-python /out/flow-prime-node-hardening.so

FROM ${NODE_IMAGE} AS node-build
ARG SOURCE_DATE_EPOCH
WORKDIR /opt/flow/node
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
    && find /opt/flow/node -xdev -exec touch --date="@${SOURCE_DATE_EPOCH}" {} +

FROM ${PYTHON_IMAGE} AS python-build
ARG SOURCE_DATE_EPOCH
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 PYTHONHASHSEED=0 SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
COPY python-requirements.lock /tmp/python-requirements.lock
COPY --from=node-build /opt/flow/node/node_modules/prime-agent/dist/prime-agent-runtime /tmp/prime-agent-runtime
RUN python -m venv --copies /opt/flow/python \
    && /opt/flow/python/bin/pip install --require-hashes --only-binary=:all: --requirement /tmp/python-requirements.lock \
    && /opt/flow/python/bin/pip install --no-deps --no-build-isolation /tmp/prime-agent-runtime \
    && /opt/flow/python/bin/python -I -c 'import bs4, dill, httpx, ipykernel, lxml, numpy, pandas, pydantic, requests, rlm, scipy, tyro, yaml' \
    && find /opt/flow/python -xdev -exec touch --date="@${SOURCE_DATE_EPOCH}" {} +

FROM ${NODE_IMAGE} AS runtime
ARG SOURCE_DATE_EPOCH
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 NODE_ENV=production PRIME_AGENT_KERNEL_FORKSERVER=0
COPY --from=python-build /opt/flow/python /opt/flow/python
COPY --from=native-build /out/flow-prime-supervisor /opt/flow/bin/flow-prime-supervisor
COPY --from=native-build /out/flow-prime-kernel-proxy /opt/flow/bin/flow-prime-kernel-proxy
COPY --from=native-build /out/flow-prime-python /opt/flow/bin/flow-prime-python
COPY --from=native-build /out/flow-prime-node-hardening.so /opt/flow/lib/flow-prime-node-hardening.so
COPY image-probe.mjs /opt/flow/bin/flow-prime-image-probe.mjs
COPY --from=node-build /opt/flow/node/node_modules /opt/flow/node/node_modules
COPY flow-dist /opt/flow/node/flow-dist
RUN groupadd --gid 10001 flow-node \
    && useradd --uid 10001 --gid 10001 --no-create-home --no-log-init --home-dir /run/flow-node flow-node \
    && groupadd --gid 10002 flow-python \
    && useradd --uid 10002 --gid 10002 --no-create-home --no-log-init --home-dir /run/flow-python/home flow-python \
    && groupadd --gid 10003 flow-shared \
    && chmod 0555 /opt/flow/bin/flow-prime-supervisor /opt/flow/bin/flow-prime-kernel-proxy /opt/flow/bin/flow-prime-python /opt/flow/bin/flow-prime-image-probe.mjs /opt/flow/lib/flow-prime-node-hardening.so \
    && touch --date="@${SOURCE_DATE_EPOCH}" /etc/passwd /etc/group /etc/shadow /etc/gshadow /etc/subuid /etc/subgid \
    && find /opt/flow -xdev -exec touch --date="@${SOURCE_DATE_EPOCH}" {} +
USER 0:10003
WORKDIR /workspace
HEALTHCHECK NONE
ENTRYPOINT ["/opt/flow/bin/flow-prime-supervisor"]
