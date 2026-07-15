#!/usr/bin/env bash
# Stand up a per-xell postgres and restore a dump into it, so a zee starts with real data
# (typically the latest prod backup). Run BY the queenzee, like the other infra scripts.
#
#   provision-xell-db.sh <name> <docker_ctx> <image> <dump_path> <db_user> <db_name>
#
# The image MUST match the dump's source server — a prod dump will not restore into a stock
# postgres because prod runs a custom postgis build. The caller reads the image off the source
# container rather than guessing.
#
# PORT: docker picks it, we read it back. A deterministic port derived from the slug collides —
# not only with other containers but with HOST services docker can't see (5443 on the NAS is
# owned by something outside docker, and `docker ps` shows nothing there). Never guess a port.
#
# Emits one JSON line. The verdict is measured, not assumed: we wait for postgres to accept
# connections and check pg_restore's exit before claiming success.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE 2>/dev/null || true

# Git Bash (MSYS) rewrites bare unix paths in argv into Windows paths before a native .exe sees
# them: `docker exec c pg_restore /tmp/x.dump` arrives as C:/Users/.../Temp/x.dump and fails with
# "could not open input file". docker cp is unaffected only because its name:/path form has a
# colon. Turn the conversion off for everything here.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

NAME="${1:?name}"; CTX="${2:?docker ctx}"; IMAGE="${3:?image}"
DUMP="${4:-}"; DBUSER="${5:-postgres}"; DBNAME="${6:-omnibiz}"
PW="${XEEHIVE_SPIN_DB_PASSWORD:-omnibiz}"
PORT=0
ERR=""

# JSON-safe: reasons can contain docker errors and Windows paths (backslashes, quotes) that would
# make this line unparseable — the caller then sees an EMPTY error and learns nothing.
esc() { printf '%s' "$1" | tr -d '\n\r' | sed 's/\\/\//g; s/"/'"'"'/g'; }
emit() { printf '{"ok":%s,"reason":"%s","container":"%s","port":%s,"image":"%s","restored":%s}\n' \
  "$1" "$(esc "$2")" "$NAME" "${PORT:-0}" "$IMAGE" "${3:-false}"; }

d() { docker --context "$CTX" "$@"; }

# Idempotent: reuse the container if it already exists — but only if it can actually START. A
# previous attempt can leave one in `Created` (e.g. its published port was taken), and silently
# "reusing" that gives you a database nobody can reach.
if [ -n "$(d ps -aq -f "name=^${NAME}$" 2>/dev/null)" ]; then
  if ! d start "$NAME" >/dev/null 2>&1; then
    ERR="$(d start "$NAME" 2>&1 | tail -1)"
    d rm -f "$NAME" >/dev/null 2>&1 || true    # unusable — rebuild it below
  fi
fi
if [ -z "$(d ps -aq -f "name=^${NAME}$" 2>/dev/null)" ]; then
  # -p 0:5432 → let docker choose a free host port; we read it back below.
  if ! d run -d --name "$NAME" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_USER="$DBUSER" -e POSTGRES_DB="$DBNAME" \
       -p 0:5432 "$IMAGE" >/dev/null 2>&1; then
    ERR="$(d run -d --name "$NAME" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_USER="$DBUSER" -e POSTGRES_DB="$DBNAME" -p 0:5432 "$IMAGE" 2>&1 | tail -1)"
    emit false "docker run failed: ${ERR//\"/\'}"; exit 1
  fi
fi

# Read back the port docker actually published.
PORT="$(d port "$NAME" 5432/tcp 2>/dev/null | head -1 | sed 's/.*://')"
[ -n "$PORT" ] || { PORT=0; emit false "could not read published port"; exit 1; }

# Wait for it to actually accept connections (a fresh postgres takes seconds to init).
ready=false
for i in $(seq 1 60); do
  if d exec "$NAME" pg_isready -U "$DBUSER" -d "$DBNAME" >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
[ "$ready" = true ] || { emit false "postgres never became ready"; exit 1; }

[ -z "$DUMP" ] && { emit true "started (no dump requested)"; exit 0; }
[ -f "$DUMP" ] || { emit false "dump not found: $DUMP"; exit 1; }

# Copy the dump in and restore. --clean --if-exists so a re-run is idempotent.
REMOTE="/tmp/$(basename "$DUMP")"
d cp "$DUMP" "${NAME}:${REMOTE}" >&2 2>&1 || { emit false "docker cp of dump failed"; exit 1; }
if d exec "$NAME" pg_restore -U "$DBUSER" --clean --if-exists --no-owner -d "$DBNAME" "$REMOTE" >&2 2>&1; then
  d exec "$NAME" rm -f "$REMOTE" >&2 2>&1 || true
  emit true restored true
else
  # pg_restore warns noisily on --clean (missing roles, existing extensions), so a non-zero exit
  # does not always mean failure. But do NOT count "any tables > 0" as success: the postgis image
  # ships ~39 tiger/topology/public extension tables, so a restore that loaded NOTHING would still
  # look like it worked. Measure the tables the DUMP was supposed to bring instead.
  RESTORED="$(d exec "$NAME" psql -U "$DBUSER" -d "$DBNAME" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema','tiger','tiger_data','topology')" 2>/dev/null | tr -d '\r ')"
  if [ "${RESTORED:-0}" -gt 50 ] 2>/dev/null; then
    d exec "$NAME" rm -f "$REMOTE" >&2 2>&1 || true
    emit true "restored with warnings ($RESTORED tables)" true
  else
    emit false "pg_restore failed — only ${RESTORED:-0} non-extension tables present" false
    exit 1
  fi
fi
