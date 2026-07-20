#!/usr/bin/env bash
# Entrypoint for the containerized queenzee (Dockerfile.server).
#
# Creates the REMOTE docker contexts before the server starts: the fleet daemons are reached by
# `docker --context <name>` everywhere (cage.js, maintenance.js, xell-db.js, …), and a fresh
# container has an empty ~/.docker — the host's context store doesn't travel with the image.
# The LOCAL daemon needs no context: compose sets DOCKER_HOST=unix:///var/run/docker.sock and
# both lib/docker.js (HTTP) and the CLI honor it for the 'default' context.
#
# Endpoints come from env so nothing is baked into the image:
#   ZEEHIVE_CTX_UGREEN   (e.g. tcp://10.1.0.18:2375)  → context ugreen-nas
#   ZEEHIVE_CTX_MARDALE  (e.g. tcp://10.2.0.16:2375)  → context mardale-prod
# Unset = skip. Idempotent: an existing context is updated, not duplicated.
set -uo pipefail

ensure_ctx() { # <name> <endpoint>
  local name="$1" ep="$2"
  [ -n "$ep" ] || return 0
  if docker context inspect "$name" >/dev/null 2>&1; then
    docker context update "$name" --docker "host=$ep" >/dev/null \
      && echo "[entrypoint] context $name → $ep (updated)" \
      || echo "[entrypoint] WARNING: could not update context $name" >&2
  else
    docker context create "$name" --docker "host=$ep" >/dev/null \
      && echo "[entrypoint] context $name → $ep (created)" \
      || echo "[entrypoint] WARNING: could not create context $name" >&2
  fi
}

ensure_ctx ugreen-nas   "${ZEEHIVE_CTX_UGREEN:-}"
ensure_ctx mardale-prod "${ZEEHIVE_CTX_MARDALE:-}"

exec node server/src/index.js
