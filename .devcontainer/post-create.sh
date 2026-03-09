#!/bin/bash
set -e

# Fix permissions for worktrees
sudo chown node:node /workspaces
sudo mkdir -p /workspaces/analyseur.worktrees || true
sudo chown node:node /workspaces/analyseur.worktrees || true

# Install Node.js dependencies
npm install

# Download Playwright browsers (Chromium, Firefox, WebKit)
# (OS-level dependencies are already installed in the Dockerfile)
npx playwright install
