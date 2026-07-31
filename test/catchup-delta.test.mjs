import test from 'node:test';
import assert from 'node:assert/strict';
import { catchupDelta } from '../server/src/queenzee/catchup-delta.js';

const led = [
  { filename: '20260101_a.sql', sha: 'aaa', applied_at: '2026-01-01T00:00:00Z' },
  { filename: '20260201_b.sql', sha: 'bbb', applied_at: '2026-02-01T00:00:00Z' },
  { filename: '20260301_c.sql', sha: 'ccc', applied_at: '2026-03-01T00:00:00Z' },
];

test('isolated: only migrations applied AFTER the snapshot are the delta', () => {
  const r = catchupDelta(led, { mode: 'isolated', takenAt: '2026-02-01T00:00:00Z' });
  // b was applied AT taken_at → in the dump (skipped); only c is after.
  assert.deepEqual(r.delta.map((d) => d.filename), ['20260301_c.sql']);
  assert.deepEqual(r.delta.map((d) => d.sha), ['ccc']);
  assert.deepEqual(r.skipped, ['20260101_a.sql', '20260201_b.sql']);
});

test('isolated: fresh snapshot → nothing to catch up', () => {
  const r = catchupDelta(led, { mode: 'isolated', takenAt: '2026-06-01T00:00:00Z' });
  assert.equal(r.delta.length, 0);
});

test('isolated: ancient snapshot → everything is the delta, in filename order', () => {
  const r = catchupDelta([...led].reverse(), { mode: 'isolated', takenAt: '2025-01-01T00:00:00Z' });
  assert.deepEqual(r.delta.map((d) => d.filename),
    ['20260101_a.sql', '20260201_b.sql', '20260301_c.sql']);
});

test('isolated: no snapshot anchor → empty delta + fallback signal (never guess)', () => {
  const r = catchupDelta(led, { mode: 'isolated', takenAt: null });
  assert.equal(r.delta.length, 0);
  assert.equal(r.reason, 'no-snapshot-anchor');
});

test('clone: delta = prod ledger minus the fork-point baseline', () => {
  const done = new Set(['20260101_a.sql', '20260201_b.sql']);
  const r = catchupDelta(led, { mode: 'clone', baselineDone: done });
  assert.deepEqual(r.delta.map((d) => d.filename), ['20260301_c.sql']);
});

test('de-dupes and keeps a file with no sha (caller falls back to main-tip)', () => {
  const dup = [
    { filename: '20260301_c.sql', sha: null, applied_at: '2026-03-01T00:00:00Z' },
    { filename: '20260301_c.sql', sha: 'ccc', applied_at: '2026-03-01T00:00:00Z' },
  ];
  const r = catchupDelta(dup, { mode: 'isolated', takenAt: '2026-01-01T00:00:00Z' });
  assert.equal(r.delta.length, 1);
  assert.equal(r.delta[0].filename, '20260301_c.sql');
});

test('ledger: delta = prod ledger minus what my db already ledgered (the exact primary path)', () => {
  // isolated-from-full-dump carries prod's ledger frozen at dump time; prod ran c afterwards.
  const mine = new Set(['20260101_a.sql', '20260201_b.sql']);
  const r = catchupDelta(led, { mode: 'ledger', done: mine });
  assert.equal(r.reason, 'ledger-set-diff');
  assert.deepEqual(r.delta.map((d) => d.filename), ['20260301_c.sql']);
});

test('ledger: my db already has everything → nothing to catch up', () => {
  const mine = new Set(led.map((r) => r.filename));
  assert.equal(catchupDelta(led, { mode: 'ledger', done: mine }).delta.length, 0);
});

test('empty prod ledger → nothing to catch up, any mode', () => {
  assert.equal(catchupDelta([], { mode: 'ledger', done: new Set() }).delta.length, 0);
  assert.equal(catchupDelta([], { mode: 'isolated', takenAt: '2026-01-01' }).delta.length, 0);
  assert.equal(catchupDelta([], { mode: 'clone', baselineDone: new Set() }).delta.length, 0);
});
