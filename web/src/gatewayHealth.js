// IS THE LLM GATEWAY REACHABLE AT THE ADDRESS CAGES ARE GIVEN? The one place the console turns
// fleet.gateway_health — the cached verdict of the queenzee's health-monitor probe
// (queenzee/gateway-health.js) — into words.
//
// It is a pure function, kept out of the JSX so every surface that shows fleet health says the
// SAME thing, and so it can be tested in plain node (the harnessHealth.js precedent). The state is
// a WORD ("gateway unreachable at http://host.docker.internal:4701"), never a shade: colour is
// reinforcement, not the signal.
//
// Why it exists at all: on 2026-08-22 the gateway address minted into cages moved to
// host.docker.internal:4701, a port no compose file published, and every dispatch died with the
// VENDOR's sentence — the console had no way to say "one of OUR ports is closed". This is that way.
export function gatewayHealthWord(g) {
  const addr = g?.address || null;
  const where = addr ? ` at ${addr}` : '';
  if (!g || !g.state || g.state === 'unknown') {
    return {
      kind: 'gateway_unknown',
      chip: `gateway not yet probed${where}`,
      why: 'The queenzee has not yet probed the LLM gateway (its health monitor has not ticked, or '
         + 'the probe was skipped).',
    };
  }
  if (g.state === 'down') {
    return {
      kind: 'gateway_down',
      chip: `⚠ gateway unreachable${where}`,
      why: g.error
        ? `The LLM gateway does not answer at ${addr} (${g.error}). Every cxell CLI in the fleet `
          + 'points its provider base-urls at this gateway, so no AI call can reach a provider '
          + 'until it answers.'
        : `The LLM gateway does not answer at ${addr}. Every cxell CLI in the fleet points its `
          + 'provider base-urls at this gateway, so no AI call can reach a provider until it answers.',
    };
  }
  // 'ok' — ANY HTTP answer proves the door answers (the reachability definition the address-mint
  // probe landed: a 404 on /api/hello is reachable, only the connection-failure family is down).
  // A non-gateway answer still says 'ok' (the port serves — the outage shape is not present) but
  // the caveat rides the tooltip so a wrong server is discoverable, not hidden.
  return {
    kind: 'gateway_ok',
    chip: `gateway ok${where}`,
    why: g.error
      ? `The gateway door answers at ${addr} — reachable — but its hello route answered "${g.error}" `
        + 'rather than the zeehive gateway service. Verify this address actually serves the gateway '
        + 'routes before trusting it for provider calls.'
      : 'The LLM gateway answers at the address cages are given.',
  };
}
