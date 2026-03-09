FROM mcr.microsoft.com/devcontainers/javascript-node:20-bookworm

# Install extra system libraries required by Playwright browsers
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libgtk-4-1 \
        libgraphene-1.0-0 \
        libavif15 && \
    rm -rf /var/lib/apt/lists/*

# Install Playwright OS dependencies during build
# We use npx to run install-deps without needing the package.json yet
# This ensures the container has all libraries needed to run the browsers
RUN npx -y playwright@1.40.0 install-deps
