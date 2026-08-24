# syntax=docker/dockerfile:1.17.1@sha256:38387523653efa0039f8e1c89bb74a30504e76ee9f565e25c9a09841f9427b05

ARG GO_IMAGE=golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651
ARG RUST_IMAGE=rust:1.89.0-bookworm@sha256:c9ac3fa8945b61dede1e4500d25028aa8fd8a8fe46365fcf9c0422f8d999b9b0
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:362e64223cc0da95422b3b13c045186fc0a81250e765d31c025fbddf257f6143
ARG SOURCE_DATE_EPOCH=1787313761

FROM ${GO_IMAGE} AS supervisor-build
ARG SOURCE_DATE_EPOCH
ARG DEPENDENCY_MANIFEST_DIGEST
ARG PROFILE_DIGEST
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go test ./... \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
      -ldflags="-s -w -buildid= \
      -X main.buildLeanVersion=4.33.1 \
      -X main.buildMathlibRevision=0df444a360eaa60ab8c11dca51a86af692955474 \
      -X main.buildSafeVerifyRevision=fb9c583eb0ea96426d94625f89b7842c9dc1c313 \
      -X main.buildLean4ExportRevision=15f6055e299ad5b89345e533cc2192f4cc00f659 \
      -X main.buildNanodaRevision=68d5ca9db226849b41a6fff59d796ff19d0a8840 \
      -X main.buildProfileDigest=${PROFILE_DIGEST} \
      -X main.buildDependencyManifestDigest=${DEPENDENCY_MANIFEST_DIGEST}" \
      -o /out/flow-proof-supervisor ./cmd/flow-proof-supervisor \
    && touch --date="@${SOURCE_DATE_EPOCH}" /out/flow-proof-supervisor

FROM ${RUST_IMAGE} AS nanoda-build
ARG SOURCE_DATE_EPOCH
ADD --checksum=sha256:30ce33ab5d17fbf7a70001660ba93e97604ddd433708687737284144d3db2a7d \
  https://codeload.github.com/robsimmons/nanoda_lib/tar.gz/68d5ca9db226849b41a6fff59d796ff19d0a8840 /tmp/nanoda.tar.gz
RUN mkdir -p /src/nanoda /out \
    && tar -xzf /tmp/nanoda.tar.gz --strip-components=1 -C /src/nanoda \
    && cd /src/nanoda \
    && RUSTFLAGS="--remap-path-prefix=/src/nanoda=. -C link-arg=-Wl,--build-id=none" \
      cargo build --locked --release \
    && cp target/release/nanoda_bin /out/nanoda_bin \
    && strip --strip-all /out/nanoda_bin \
    && touch --date="@${SOURCE_DATE_EPOCH}" /out/nanoda_bin

FROM ${DEBIAN_IMAGE} AS lean-build
ARG SOURCE_DATE_EPOCH
ENV PATH=/opt/lean/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LEAN_ABORT_ON_PANIC=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
COPY --from=supervisor-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260823T000000Z bookworm main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20260823T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/* \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git zstd \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:890afd185370f85666025b883914ab4f4b339136f8c96167b69cfb62aecaf235 \
  https://github.com/leanprover/lean4/releases/download/v4.33.1/lean-4.33.1-linux.tar.zst /tmp/lean.tar.zst
ADD --checksum=sha256:f046f7c7f2f8f47e14235d97cd7728a6ae74becf5f7d482b5d865d8c3bf538ef \
  https://codeload.github.com/mistralai/LeanstralSafeVerify/tar.gz/fb9c583eb0ea96426d94625f89b7842c9dc1c313 /tmp/safe-verify.tar.gz
ADD --checksum=sha256:266271a9c062e31535518475a20b69e92f8516d74832d3866f00298e7192eade \
  https://codeload.github.com/leanprover/lean4export/tar.gz/15f6055e299ad5b89345e533cc2192f4cc00f659 /tmp/lean4export.tar.gz
ADD --checksum=sha256:4906567b829fea7e354022c603aeebead7dd2f4ad1a39a91cc42ffae5de46326 \
  https://codeload.github.com/leanprover-community/mathlib4/tar.gz/0df444a360eaa60ab8c11dca51a86af692955474 /tmp/mathlib.tar.gz
RUN mkdir -p /opt/lean \
    && tar --use-compress-program=unzstd -xf /tmp/lean.tar.zst --strip-components=1 -C /opt/lean \
    && test "$(lean --version | sed -n '1s/Lean (version \([^,]*\).*/\1/p')" = 4.33.1
RUN mkdir -p /src/safe-verify /opt/flow/bin \
    && tar -xzf /tmp/safe-verify.tar.gz --strip-components=1 -C /src/safe-verify \
    && printf 'leanprover/lean4:v4.33.1\n' > /src/safe-verify/lean-toolchain \
    && cd /src/safe-verify \
    && lake build safe_verify \
    && cp .lake/build/bin/safe_verify /opt/flow/bin/safe_verify
RUN mkdir -p /src/lean4export \
    && tar -xzf /tmp/lean4export.tar.gz --strip-components=1 -C /src/lean4export \
    && printf 'leanprover/lean4:v4.33.1\n' > /src/lean4export/lean-toolchain \
    && cd /src/lean4export \
    && lake build lean4export \
    && cp .lake/build/bin/lean4export /opt/flow/bin/lean4export
RUN mkdir -p /src/mathlib-expected /opt/flow/lean-lib \
    && tar -xzf /tmp/mathlib.tar.gz --strip-components=1 -C /src/mathlib-expected \
    && test "$(sha256sum /src/mathlib-expected/lake-manifest.json | cut -d ' ' -f 1)" = 1009a101f52a9d5d8ca57666f0256bae91abdb693e0f27b5a4622cffcc38cf03 \
    && git clone --filter=blob:none https://github.com/leanprover-community/mathlib4.git /opt/flow/mathlib \
    && cd /opt/flow/mathlib \
    && git checkout --detach 0df444a360eaa60ab8c11dca51a86af692955474 \
    && diff --recursive --brief --exclude=.git /src/mathlib-expected /opt/flow/mathlib \
    && lake exe cache get \
    && mkdir -p /opt/flow/lean-lib \
    && for library in /opt/flow/mathlib/.lake/build/lib/lean /opt/flow/mathlib/.lake/packages/*/.lake/build/lib/lean; do \
         if [ -d "$library" ]; then \
           find "$library" -mindepth 1 -maxdepth 1 -print; \
         fi; \
       done | sort -u > /tmp/lean-library-entries \
    && while IFS= read -r entry; do \
         name="$(basename "$entry")"; \
         if [ -e "/opt/flow/lean-lib/$name" ]; then exit 1; fi; \
         ln -s "$entry" "/opt/flow/lean-lib/$name"; \
       done < /tmp/lean-library-entries \
    && find /opt/flow/mathlib -type d -name .git -prune -exec rm -rf {} + \
    && touch --date="@${SOURCE_DATE_EPOCH}" /opt/flow/bin/safe_verify /opt/flow/bin/lean4export

FROM ${DEBIAN_IMAGE} AS runtime
ARG SOURCE_DATE_EPOCH
ARG DEPENDENCY_MANIFEST_DIGEST
ARG PROFILE_DIGEST
ARG SUPERVISOR_SHA256
ARG SAFE_VERIFY_SHA256
ARG LEAN4EXPORT_SHA256
ARG NANODA_SHA256
ARG MATHLIB_MANIFEST_SHA256
ENV HOME=/workspace/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/opt/flow/bin:/opt/lean/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LEAN_ABORT_ON_PANIC=1
COPY --from=lean-build /opt/lean /opt/lean
COPY --from=lean-build /opt/flow /opt/flow
COPY --from=supervisor-build /out/flow-proof-supervisor /opt/flow/bin/flow-proof-supervisor
COPY --from=nanoda-build /out/nanoda_bin /opt/flow/bin/nanoda_bin
RUN groupadd --gid 10001 flow-proof \
    && useradd --uid 10001 --gid 10001 --no-create-home --no-log-init --home-dir /workspace/home flow-proof \
    && chmod 0555 /opt/flow/bin/flow-proof-supervisor /opt/flow/bin/safe_verify /opt/flow/bin/lean4export /opt/flow/bin/nanoda_bin \
    && touch --date="@${SOURCE_DATE_EPOCH}" /etc/passwd /etc/group /etc/shadow /etc/gshadow \
    && find /opt/flow -xdev -exec touch --no-dereference --date="@${SOURCE_DATE_EPOCH}" {} +
LABEL org.opencontainers.image.title="Flow Lean proof appliance" \
      org.opencontainers.image.licenses="Apache-2.0" \
      ai.synapti.flow.proof.profile="${PROFILE_DIGEST}" \
      ai.synapti.flow.proof.dependencies="${DEPENDENCY_MANIFEST_DIGEST}" \
      ai.synapti.flow.proof.lean="4.33.1" \
      ai.synapti.flow.proof.mathlib="0df444a360eaa60ab8c11dca51a86af692955474" \
      ai.synapti.flow.proof.supervisor="${SUPERVISOR_SHA256}" \
      ai.synapti.flow.proof.safe-verify="${SAFE_VERIFY_SHA256}" \
      ai.synapti.flow.proof.lean4export="${LEAN4EXPORT_SHA256}" \
      ai.synapti.flow.proof.nanoda="${NANODA_SHA256}" \
      ai.synapti.flow.proof.mathlib-manifest="${MATHLIB_MANIFEST_SHA256}" \
      ai.synapti.flow.proof.safe-verify-revision="fb9c583eb0ea96426d94625f89b7842c9dc1c313" \
      ai.synapti.flow.proof.lean4export-revision="15f6055e299ad5b89345e533cc2192f4cc00f659" \
      ai.synapti.flow.proof.nanoda-revision="68d5ca9db226849b41a6fff59d796ff19d0a8840"
USER 0:10001
WORKDIR /workspace
HEALTHCHECK NONE
ENTRYPOINT ["/opt/flow/bin/flow-proof-supervisor"]
