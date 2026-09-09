#!/bin/bash
# Cxell egress policy. The CONTAINER is the confinement boundary: a cxell zee has no host mount,
# no docker socket, and no route to other xells' worktrees — it physically cannot edit or reach
# anything outside its own cxell no matter what its network does. So locking egress down buys
# almost nothing, and doing it broke `npm ci` / builds (the registry got blocked) for zero real
# safety. We DON'T do that anymore.
#
# The ONE thing worth blocking is the LIVE PRODUCTION DATABASE(S): Docker's bridge NATs the cxell
# onto the LAN, so without a rule a zee could open TCP straight to prod (proven 2026-07-19:
# 10.2.0.16:5432 was reachable). So: default ACCEPT egress; DROP only the host:port pairs in
# $CXELL_BLOCK_TCP (the fleet's prod DBs). A xell deliberately bound to prod (/xell-prod) gets its
# own prod DB left OUT of that list by the queenzee, so it can reach it.
#
# Run as root (docker exec -u 0); needs --cap-add NET_ADMIN.
set -uo pipefail
BLOCK_TCP=${CXELL_BLOCK_TCP:-}

iptables -F OUTPUT
iptables -P OUTPUT ACCEPT

for hp in $BLOCK_TCP; do
  bhost=${hp%:*}; bport=${hp##*:}
  for ip in $(getent ahostsv4 "$bhost" | awk '{print $1}' | sort -u); do
    iptables -A OUTPUT -d "$ip" -p tcp --dport "$bport" -j DROP
    echo "block prod db $bhost -> $ip:$bport"
  done
done

# The MESH route (docs/netbird-mesh-plan.md §3.5): a cxell reaches mesh addresses through the
# queenzee's mesh-gateway container on zee-hive-net, not through a per-cage agent. MESH_GATEWAY_IP
# (the gateway's zee-hive-net address) unset = no mesh on this install — the legacy published ports
# stay the whole story and nothing here changes. The route replaces (idempotent) so a re-seal with a
# new gateway address converges instead of stacking.
MESH_GATEWAY_IP=${MESH_GATEWAY_IP:-}
MESH_CIDR=${MESH_CIDR:-100.64.0.0/10}
if [ -n "$MESH_GATEWAY_IP" ]; then
  ip route replace "$MESH_CIDR" via "$MESH_GATEWAY_IP"
  echo "mesh route: $MESH_CIDR via $MESH_GATEWAY_IP"
fi

echo "cxell egress: default ALLOW; blocked prod db(s): ${BLOCK_TCP:-none}"
