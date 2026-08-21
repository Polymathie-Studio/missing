// Regression tests for the conformance report and reconcile verbs.
// Run: node --test test/conformance.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { report, reconcile } from '../conformance.js';

const URL = 'https://x.com/';
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
};

// Passes every machine axis: operable, hardened, findability, delivery.
const CLEAN = `<!doctype html><html lang="en"><head>
<title>Home</title>
<meta name="description" content="A page about a thing.">
<link rel="canonical" href="https://x.com/">
<meta property="og:url" content="https://x.com/">
<meta property="og:image" content="https://x.com/og.png">
</head><body><p>Hello.</p></body></html>`;

const opts = { url: URL, headers: HEADERS };

test('a machine-clean surface is audited on the four machine axes and re-provable on the two procedure axes', () => {
  const r = report(CLEAN, opts);
  assert.equal(r.breadth.of, 6);
  assert.equal(r.breadth.auditedPass, 4);
  assert.equal(r.breadth.auditedFail, 0);
  assert.equal(r.breadth.reProvable, 2);
  assert.equal(r.breadth.complete, false);
  assert.equal(r.earned, false);
  assert.equal(r.level, 're-provable');
  for (const key of ['operable', 'hardened', 'findability', 'delivery']) {
    assert.equal(r.axes[key].rung, 'audited', `${key} should be audited`);
    assert.equal(r.axes[key].result, 'pass', `${key} should pass`);
    assert.equal(r.axes[key].needs, null);
  }
  for (const key of ['perceivable', 'offHappyPath']) {
    assert.equal(r.axes[key].rung, 're-provable', `${key} should be re-provable`);
    assert.equal(r.axes[key].result, null);
    assert.ok(r.axes[key].needs, `${key} should name what it needs`);
  }
});

test('supplying the two procedure results lifts the surface to MISSING Conformant, audited', () => {
  const r = report(CLEAN, { ...opts, results: { perceivable: 'pass', offHappyPath: 'pass' } });
  assert.equal(r.breadth.auditedPass, 6);
  assert.equal(r.breadth.reProvable, 0);
  assert.equal(r.breadth.complete, true);
  assert.equal(r.earned, true);
  assert.equal(r.level, 'audited');
  assert.equal(r.axes.perceivable.rung, 'audited');
  assert.match(r.overall, /MISSING Conformant, audited/);
});

test('a failed procedure result is audited and failing, not conformant', () => {
  const r = report(CLEAN, { ...opts, results: { perceivable: 'fail', offHappyPath: 'pass' } });
  assert.equal(r.axes.perceivable.rung, 'audited');
  assert.equal(r.axes.perceivable.result, 'fail');
  assert.equal(r.breadth.auditedFail, 1);
  assert.equal(r.earned, false);
});

test('an exposed key makes the hardened axis audited and failing', () => {
  const withKey = CLEAN.replace('<p>Hello.</p>', '<script>const k="sk-abcdefghijklmnopqrstuvwxyz012345";</script>');
  const r = report(withKey, opts);
  assert.equal(r.axes.hardened.rung, 'audited');
  assert.equal(r.axes.hardened.result, 'fail');
  assert.ok(r.breadth.auditedFail >= 1);
  assert.equal(r.earned, false);
});

test('without response headers the hardened axis is re-provable, not silently clean', () => {
  const r = report(CLEAN, { url: URL });
  assert.equal(r.axes.hardened.rung, 're-provable');
  assert.ok(/header/i.test(r.axes.hardened.needs));
});

test('a report is JSON-serializable and round-trips', () => {
  const r = report(CLEAN, opts);
  const round = JSON.parse(JSON.stringify(r));
  assert.deepEqual(round.breadth, r.breadth);
  assert.equal(round.axes.operable.rung, 'audited');
});

test('reconcile refutes a passing claim the fresh audit proves failing', () => {
  const withKey = CLEAN.replace('<p>Hello.</p>', '<script>const k="sk-abcdefghijklmnopqrstuvwxyz012345";</script>');
  const claim = { axes: { hardened: { rung: 'audited', result: 'pass' } } };
  const rec = reconcile(claim, withKey, opts);
  assert.equal(rec.ok, false);
  assert.ok(rec.findings.some((f) => f.code === 'result-overclaim'));
});

test('reconcile accepts a passing claim the fresh audit confirms', () => {
  const claim = { axes: { hardened: { rung: 'audited', result: 'pass' } } };
  const rec = reconcile(claim, CLEAN, opts);
  assert.equal(rec.ok, true);
  assert.equal(rec.findings.length, 0);
});

test('reconcile notes a procedure axis claim as author-attested, not refuted', () => {
  const claim = { axes: { perceivable: { rung: 'audited', result: 'pass' } } };
  const rec = reconcile(claim, CLEAN, opts);
  assert.equal(rec.ok, true);
  assert.ok(rec.findings.some((f) => f.code === 'author-attested'));
});
