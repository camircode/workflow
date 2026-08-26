# syntax=docker/dockerfile:1

# Multi-stage so the toolchain never reaches the running image. A TypeScript
# compiler, a package manager and a test runner in production are attack surface
# that does nothing once the build is over.

# --- dependencies -------------------------------------------------------------
# Its own stage, and only the manifests are copied, so this layer is cached
# unless the lockfile changes. Ordinary code changes do not re-resolve the tree.
FROM node:24-alpine AS deps
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- build --------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY --from=deps /src/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# --- runtime dependencies -----------------------------------------------------
# Resolved separately from the build tree: --prod drops TypeScript, vitest,
# tsx and Testcontainers, which is most of what was installed and none of what
# is needed to serve a request.
FROM node:24-alpine AS runtime-deps
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- the image that runs ------------------------------------------------------
# Distroless carries no shell, no package manager and no libc beyond what Node
# needs. Anyone who gets code execution in this container arrives somewhere with
# nothing to use.
FROM gcr.io/distroless/nodejs24-debian13:nonroot

WORKDIR /app

COPY --from=runtime-deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist

# The migrations travel with the image and are applied at startup, so the schema
# a container expects and the schema it creates cannot disagree.
COPY db/migrations ./db/migrations

# Matches runAsNonRoot in the Deployment. Declaring it here as well means the
# image is safe to run without a securityContext rather than depending on one.
USER 65532:65532

EXPOSE 8080

# distroless/nodejs already has node as its entrypoint, so this is the script.
CMD ["dist/main.js"]
