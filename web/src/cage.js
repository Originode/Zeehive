// THE CAGE BUTTON — restart one xell's cxell container, from wherever the operator noticed it was
// dead. Shared by the xell card (the ⟳ cage button beside ⌨ terminal) and by the terminal modal
// itself, because the terminal is where a wedged cage is USUALLY discovered: the pane says
// "error"/"closed" and, until this existed, there was nothing an operator could do about it without
// a host session and a docker socket.
//
// It lives in its own module rather than in App.jsx so both surfaces call the SAME confirm text and
// the same reporting of the verdicts (App imports ZeeTerminal, so ZeeTerminal cannot import App).
import { cxellStatus, restartXellCxell } from './api.js';
import { showAlert, showConfirm } from './Dialog.jsx';

// RESTART THIS XELL'S CAGE — the operator's cure for a cxell that has stopped working while docker
// still calls it healthy (dead sshd, hung agent, a turn that went silent). The queenzee's recovery
// loop cannot see that failure: it acts on containers that are EXITED, and this one is not.
//
// It PROBES BEFORE IT ASKS, and that is the whole reason this is not a one-line onClick. The only
// dangerous version of this button is the one that stops a container with a live turn inside it, so
// the dialog has to know — from the cage itself, right now, not from the dashboard's cached row —
// whether that is what is about to happen, and say so in those words. A confirm that guesses is
// worse than no confirm: it teaches the operator that the warning means nothing.
//
// Everything the server refuses ('missing', 'unknown', 'no-cxell') comes back as a verdict, and each
// one is reported as what it is. A GONE cage is the one that must never read as a failed restart:
// nothing here recreates a container, because a new one wearing the same name would have none of the
// zee's work — that is a human's decision to re-dispatch, not a button's.
export async function restartXellCage(x, onDone) {
  let st;
  try { st = await cxellStatus(x.id); }
  catch (err) { return showAlert('Could not read the cage state: ' + (err?.message || err), { variant: 'error' }); }

  if (!st?.ok) {
    return showAlert(`${x.slug}: ${st?.verdict === 'no-cxell'
      ? 'this xell has no live caged zee, so there is no container to restart.'
      : (st?.error || 'the cage could not be read.')}`, { variant: 'error' });
  }
  if (st.missing) {
    return showAlert(`${x.slug}: its container (${st.name}) is GONE — it no longer exists on the host.\n\n`
      + 'It is deliberately NOT recreated: a fresh cage would have none of this zee\'s uncollected work, '
      + 'while wearing its name. Re-dispatch the work if it is still wanted.', { variant: 'error' });
  }
  if (st.state === 'unknown') {
    return showAlert(`${x.slug}: the cage could not be probed (${st.error || 'no answer from docker'}).\n\n`
      + 'Nothing was done — an unreadable cage is never assumed to be down.', { variant: 'error' });
  }

  const running = st.state === 'running';
  const live = st.mid_turn
    ? `\n\n⚠ A TURN IS LIVE in there right now (the zee is '${st.zee_status}'). Restarting ENDS it. `
      + 'The queenzee closes that turn honestly and resumes the session immediately in the fresh cage, '
      + 'telling the zee a human restarted its container — but whatever it was mid-thought about is gone.'
    : `\n\nNo turn is live (the zee is '${st.zee_status}'), so nothing is interrupted.`;
  const ok = await showConfirm(
    `Restart ${x.slug}'s cage?\n\nThe container is ${st.state.toUpperCase()}.`
    + (running
      ? ' Docker still calls it healthy, so the queenzee\'s recovery loop will never touch it — '
        + 'this stops it and starts it again.'
      : ' The queenzee will start it again.')
    + '\n\nOrder: stop → start → re-open the ssh door → RE-APPLY the egress firewall → resume the session. '
    + 'If the firewall cannot be re-applied the cage is stopped again and a human is raised — a cage that '
    + 'cannot be sealed is never left running.'
    + '\n\nThe zee\'s files, commits and database survive (a restart is not a rebuild). Anything it had '
    + 'RUNNING inside — a build poll, a dev server — does not.'
    + live,
    { title: 'Restart cage', variant: running ? 'error' : 'info',
      okLabel: running ? 'Stop and restart' : 'Restart' });
  if (!ok) return;

  let r;
  try { r = await restartXellCxell(x.id, { force: running }); }
  catch (err) { return showAlert('Restart failed: ' + (err?.message || err), { variant: 'error' }); }
  onDone?.();

  if (r?.verdict === 'restarted') {
    return showAlert(`${x.slug}: cage restarted — ssh door re-opened and egress firewall re-applied.\n\n`
      + (r.resumed_now ? 'The zee\'s session has been resumed; watch the terminal.'
        : r.held_paused ? 'The zee\'s session was NOT resumed: this fleet/project/xell is PAUSED, and a '
          + 'resume is a turn. It is held, not lost — press play and the zee is called back.'
        : r.resumed ? `The zee's session could not be resumed on the spot, so it is on the revive ladder `
          + `(~${r.in_minutes} minute(s)).`
        : 'No turn was live, so nothing was resumed — open the terminal to pick it up.'));
  }
  if (r?.verdict === 'unsealed') {
    return showAlert(`${x.slug}: the cage came back but its EGRESS FIREWALL could not be re-applied, so it was `
      + `${r.stopped ? 'STOPPED AGAIN' : 'left running (it could NOT be stopped either — seal or stop it by hand)'}`
      + ` and no turn was resumed. A tend is raised on the xell.\n\n${r.error || ''}`, { variant: 'error' });
  }
  if (r?.verdict === 'would-restart') {
    return showAlert(`${x.slug}: NOT restarted — this queenzee runs in PROVISION_MODE=simulate and the cage `
      + 'named by this row belongs to the real fleet.');
  }
  return showAlert(`${x.slug}: not restarted (${r?.verdict || 'unknown'})`
    + (r?.reason || r?.error ? ` — ${r.reason || r.error}` : ''), { variant: 'error' });
}

