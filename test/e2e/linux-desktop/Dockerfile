# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0t64 libnotify4 libnss3 xdg-utils libatspi2.0-0t64 libdrm2 \
      libgbm1 libxcb-dri3-0 libglib2.0-bin libasound2t64 libatk-bridge2.0-0t64 \
      libatk1.0-0t64 libc6 libcairo2 libcups2t64 libdbus-1-3 libexpat1 \
      libgcc-s1 libgdk-pixbuf-2.0-0 libgl1 libglib2.0-0t64 libnspr4 \
      libpango-1.0-0 libstdc++6 libudev1 libusb-1.0-0 libx11-6 libx11-xcb1 \
      libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
      libxrandr2 mesa-vulkan-drivers xz-utils \
      xvfb xauth x11-apps x11-utils dbus-x11 netpbm \
      ca-certificates curl unzip sqlite3 procps iproute2 \
    && rm -rf /var/lib/apt/lists/*

ARG BUN_VERSION=1.4.2
ARG BUN_SHA256=54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7
RUN curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64.zip" \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp \
    && install -m 0755 /tmp/bun-linux-aarch64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-aarch64 \
    && bun --version

ARG CHATGPT_DEB_SHA256
RUN --mount=from=deb,source=chatgpt_arm64.deb,target=/tmp/chatgpt_arm64.deb \
    echo "${CHATGPT_DEB_SHA256}  /tmp/chatgpt_arm64.deb" | sha256sum -c - \
    && dpkg -i /tmp/chatgpt_arm64.deb \
    && rm -f /etc/apt/sources.list.d/chatgpt.sources \
    && test -x /usr/bin/chatgpt \
    && cat /usr/lib/chatgpt/version

RUN ln -s /usr/lib/chatgpt/resources/cua_node/bin/node /usr/local/bin/node && node --version

ARG CLAUDE_VERSION
ARG CLAUDE_SHA256
RUN curl -fsSL -o /usr/local/bin/claude \
      "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/linux-arm64/claude" \
    && echo "${CLAUDE_SHA256}  /usr/local/bin/claude" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/claude \
    && claude --version

RUN groupadd --gid 1001 tester && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash tester && mkdir -p /out && chmod 0777 /out

WORKDIR /harness
COPY package.json bun.lock ./
ENV BUN_INSTALL_CACHE_DIR=/opt/bun-cache
RUN bun install --frozen-lockfile
COPY test/e2e/linux-desktop/entrypoint.ts test/e2e/linux-desktop/commands.ts ./
RUN bun build --compile entrypoint.ts --outfile /usr/local/bin/linux-desktop-e2e \
    && rm -rf /harness \
    && chown -R tester:tester /opt/bun-cache

WORKDIR /repo
COPY package.json bun.lock ./
COPY tsconfig.json README.md ./
COPY src ./src
COPY test/e2e/linux-desktop/driver.ts test/e2e/linux-desktop/claude.ts test/e2e/linux-desktop/process.ts test/e2e/linux-desktop/commands.ts ./test/e2e/linux-desktop/
RUN chown -R tester:tester /repo

ENV NUDGE_E2E_IMAGE=1
ENTRYPOINT ["/usr/local/bin/linux-desktop-e2e"]
