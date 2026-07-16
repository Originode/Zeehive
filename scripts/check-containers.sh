#!/usr/bin/env bash
# Deterministic container-health probe — run BY the queenzee (same pattern as
# provision-xell.sh / despawn-xell.sh: the infra command lives in a script, the Node
# projector just schedules it and ingests the result into the meta-DB). No AI, no DB here.
#
#   check-containers.sh <docker-context> [<docker-context> ...]
#
# For every requested context it prints one TSV line per container:
#     <ctx>\t<name>\t<state>\t<zeehive.xell>\t<zeehive.project>\t<zeehive.role>
# e.g.  ugreen-nas   omnibiz_db_dev_gis   running   -   -   -
# The last three columns are the identity labels ZEEHIVE-provisioned containers carry
# (spec §3.3); '-' when unlabeled (pre-label containers, foreign containers).
# If that context's daemon can't be reached at all:
#     <ctx>\t__UNREACHABLE__\t-
# (a reachable-but-empty daemon simply emits no lines for that ctx).
set -uo pipefail

DOCKER="${DOCKER_BIN:-docker}"
FMT='{{.Names}}\t{{.State}}\t{{or (.Label "zeehive.xell") "-"}}\t{{or (.Label "zeehive.project") "-"}}\t{{or (.Label "zeehive.role") "-"}}'

for ctx in "$@"; do
  if out="$("$DOCKER" --context "$ctx" ps -a --format "$FMT" 2>/dev/null)"; then
    while IFS= read -r line; do
      [ -n "$line" ] && printf '%s\t%s\n' "$ctx" "$line"
    done <<< "$out"
  else
    printf '%s\t__UNREACHABLE__\t-\n' "$ctx"
  fi
done
