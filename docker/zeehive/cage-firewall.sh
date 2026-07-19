#!/bin/bash
# Seal the zee cage: default-DROP egress, allow only what a zee needs.
# Run as root (docker exec -u 0, or an entrypoint before dropping to `zee`);
# requires the container to be started with --cap-add NET_ADMIN.
#
# Docker's default bridge NATs containers straight onto the LAN — without this,
# a caged zee can open TCP to prod (proven 2026-07-19: 10.2.0.16:5432 reachable).
#
# Allowed:
#   - loopback, established/related
#   - DNS to the embedded resolver (127.0.0.11)
#   - HTTPS to the domains in $CAGE_ALLOW_DOMAINS (default: api.anthropic.com),
#     resolved at seal time — rotating CDN IPs mean re-run to refresh, or front
#     with an egress proxy later
#   - the queenzee API at $CAGE_QUEENZEE (host:port, e.g. host.docker.internal:4700)
#   - anything on the xell's own docker network ($CAGE_SUBNET, e.g. 172.28.0.0/16)
#   - the xell's OWN stack, as explicit host:port pairs in $CAGE_ALLOW_TCP (space-separated,
#     e.g. "10.1.0.18:3145 10.1.0.18:5245") — this is how a caged zee reaches its assigned
#     app/db containers when they live on another docker host, without the LAN opening up
# Everything else: DROP.
set -euo pipefail

ALLOW_DOMAINS=${CAGE_ALLOW_DOMAINS:-api.anthropic.com}
QUEENZEE=${CAGE_QUEENZEE:-}
SUBNET=${CAGE_SUBNET:-}
ALLOW_TCP=${CAGE_ALLOW_TCP:-}

iptables -F OUTPUT
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -d 127.0.0.11 -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j ACCEPT

for d in $ALLOW_DOMAINS; do
  for ip in $(dig +short A "$d" | grep -E '^[0-9.]+$'); do
    iptables -A OUTPUT -d "$ip" -p tcp --dport 443 -j ACCEPT
    echo "allow $d -> $ip:443"
  done
done

if [[ -n "$QUEENZEE" ]]; then
  qhost=${QUEENZEE%:*}; qport=${QUEENZEE##*:}
  for ip in $(getent ahostsv4 "$qhost" | awk '{print $1}' | sort -u); do
    iptables -A OUTPUT -d "$ip" -p tcp --dport "$qport" -j ACCEPT
    echo "allow queenzee $qhost -> $ip:$qport"
  done
fi

if [[ -n "$SUBNET" ]]; then
  iptables -A OUTPUT -d "$SUBNET" -j ACCEPT
  echo "allow xell subnet $SUBNET"
fi

for hp in $ALLOW_TCP; do
  ahost=${hp%:*}; aport=${hp##*:}
  for ip in $(getent ahostsv4 "$ahost" | awk '{print $1}' | sort -u); do
    iptables -A OUTPUT -d "$ip" -p tcp --dport "$aport" -j ACCEPT
    echo "allow stack $ahost -> $ip:$aport"
  done
done

echo "cage sealed: default egress DROP"
