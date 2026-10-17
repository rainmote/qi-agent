# Both base images are immutable; the tested platform is linux/arm64.
ARG NODE_IMAGE=mirror.gcr.io/library/node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG RUST_IMAGE=mirror.gcr.io/library/rust@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e
FROM ${NODE_IMAGE} AS node
FROM ${RUST_IMAGE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 && \
    rm -rf /var/lib/apt/lists/*
COPY scripts/install-ci-babashka.sh /opt/install-bb.sh
RUN bash /opt/install-bb.sh /usr/local/bin && rustup component add clippy rustfmt
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/qi-cache/browsers
WORKDIR /opt/qi-source
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --registry=https://registry.npmjs.org
RUN npx playwright install --with-deps --only-shell chromium && \
    mkdir -p /opt/qi-cache && mv node_modules /opt/qi-cache/node_modules
COPY . .
ENV CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
RUN if [ -f .qi-image-baseline/apps/tui-rs/Cargo.toml ]; then \
      cargo fetch --locked --manifest-path .qi-image-baseline/apps/tui-rs/Cargo.toml; \
    fi && \
    cargo build --locked --all-targets --manifest-path apps/tui-rs/Cargo.toml && \
    mv apps/tui-rs/target /opt/qi-cache/target && \
    sha256sum package-lock.json apps/tui-rs/Cargo.lock > /opt/qi-cache/locks.sha256 && \
    if [ -f .qi-image-baseline/apps/tui-rs/Cargo.lock ]; then \
      (cd .qi-image-baseline && sha256sum package-lock.json apps/tui-rs/Cargo.lock) > /opt/qi-cache/baseline-locks.sha256; \
    fi && \
    chmod -R a+rX /opt/qi-cache && \
    rm -rf /opt/qi-source
COPY maintenance/image/entrypoint.sh /usr/local/bin/qi-maintenance-entrypoint
RUN chmod 755 /usr/local/bin/qi-maintenance-entrypoint
ENV CARGO_NET_OFFLINE=true CARGO_HOME=/tmp/qi-cargo
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/qi-maintenance-entrypoint"]
