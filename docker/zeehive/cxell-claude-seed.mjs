#!/usr/bin/env node
// Pre-answer Claude Code's first-run gauntlet INSIDE the cxell so a human ATTENDING a cxell zee
// over the dashboard terminal (ws → ssh → tmux → `claude`) never sees onboarding/theme/trust/
// bypass prompts — the cxell is a fixed, trusted environment we control.
//
// Merges the answering keys into ~/.claude.json (default) or the path in argv[2], PRESERVING
// anything Claude has already written (machineID, userID, session bookkeeping). Idempotent, so
// it is safe to bake at image build AND re-run at spawn (cxell-sshd.sh) as a belt-and-suspenders.
//
// Keys (measured on claude 2.1.215): hasCompletedOnboarding kills the welcome + theme picker;
// per-project hasTrustDialogAccepted kills "do you trust the files in this folder?" for the
// zee's fixed /work/repo cwd; bypassPermissionsModeAccepted kills the --dangerously-skip-
// permissions acknowledgement the attach uses (the cxell is the permission system).
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const path = process.argv[2] || join(homedir(), '.claude.json');
const PROJECT = process.env.CXELL_PROJECT || '/work/repo';

let cfg = {};
try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { /* fresh */ }

cfg.hasCompletedOnboarding = true;      // welcome screen + theme picker + "terminal setup"
cfg.bypassPermissionsModeAccepted = true; // the --dangerously-skip-permissions acknowledgement
if (!cfg.theme) cfg.theme = 'dark';     // Claude drops this on rewrite, but onboarding-complete stops the re-prompt

cfg.projects = cfg.projects || {};
const proj = cfg.projects[PROJECT] || {};
proj.hasTrustDialogAccepted = true;         // "Is this a project you trust?" for the cxell cwd
proj.hasCompletedProjectOnboarding = true;
if (proj.projectOnboardingSeenCount == null) proj.projectOnboardingSeenCount = 1;
proj.hasSeenTasksHint = true;
cfg.projects[PROJECT] = proj;

writeFileSync(path, JSON.stringify(cfg, null, 2));
process.stdout.write(`seeded ${path} (onboarding+theme+trust+bypass answered for ${PROJECT})\n`);
