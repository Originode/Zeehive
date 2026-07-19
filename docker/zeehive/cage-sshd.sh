#!/bin/bash
# Open the cage's SSH door so a human can ATTEND the zee — the dashboard terminal (ssh2→xterm)
# and Claude Code desktop both come in this way. Run as root (docker exec -u 0) after the cage
# is up; idempotent. Args via env:
#   CAGE_PUBKEY  — the Zeehive public key authorized for user `zee`
#   CAGE_ENV     — lines to drop in /etc/environment so an SSH (PAM) login shell inherits the
#                  Claude token, e.g. "ANTHROPIC_AUTH_TOKEN=sk-ant-…" (interactive `claude`
#                  needs it; a docker-exec -e run gets it directly, an SSH login does not)
set -euo pipefail

# Host keys (first run only) and a hardened, key-only sshd.
ssh-keygen -A
cat > /etc/ssh/sshd_config.d/cage.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin no
AllowUsers zee
X11Forwarding no
PermitTunnel no
AllowAgentForwarding no
AllowTcpForwarding no
EOF

if [[ -n "${CAGE_PUBKEY:-}" ]]; then
  install -o zee -g zee -m 700 -d /home/zee/.ssh
  echo "$CAGE_PUBKEY" > /home/zee/.ssh/authorized_keys
  chown zee:zee /home/zee/.ssh/authorized_keys
  chmod 600 /home/zee/.ssh/authorized_keys
fi

# Pre-answer Claude Code's first-run gauntlet for the zee user so an ATTENDING human never sees
# onboarding/theme/trust/bypass prompts. Idempotent (merges the keys, preserving whatever Claude
# has already written) — the image bakes this too, but re-running here keeps a cage seeded even if
# it was built from an older image. Written as root, then handed back to zee.
if [[ -x /usr/local/bin/cage-claude-seed.mjs ]]; then
  node /usr/local/bin/cage-claude-seed.mjs /home/zee/.claude.json || true
  chown zee:zee /home/zee/.claude.json && chmod 600 /home/zee/.claude.json
fi

# Token for interactive SSH logins. /etc/environment is read by PAM at login, so an SSH shell
# (which a docker-exec -e run bypasses) still comes up authenticated. 0600 root — the zee's own
# shell can read it via the login env, but it is not world-readable in the fs.
if [[ -n "${CAGE_ENV:-}" ]]; then
  printf '%s\n' "$CAGE_ENV" > /etc/environment
  chmod 600 /etc/environment
fi

# (Re)start sshd. -e keeps logs on stderr; & so the exec returns.
pkill -x sshd 2>/dev/null || true
/usr/sbin/sshd
echo "cage sshd up (key-only, user zee)"
