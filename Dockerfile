# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

# Tools needed for native module compilation (better-sqlite3 needs these)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy lockfile first so Docker can cache the install layer
COPY prototype/package.json prototype/package-lock.json ./prototype/
WORKDIR /app/prototype

# npm ci uses the EXACT versions in package-lock.json. No upgrades, no surprises.
# This is the only command that touches the npm registry, and it runs INSIDE
# the container — your laptop's home directory is not accessible from here.
RUN npm ci --no-audit --no-fund

# Now copy the rest of the app
WORKDIR /app
COPY prototype/ ./prototype/

WORKDIR /app/prototype
EXPOSE 4000
CMD ["node", "server.js"]
