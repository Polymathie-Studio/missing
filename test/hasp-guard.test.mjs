// Regression tests for the hasp-guard hardening generator.
// The load-bearing test is the round-trip: hasp-guard writes the headers, hardened.js
// audits them, and the two must agree (Tiers 1 and 2 clear).
// Run: node --test test/hasp-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csp, securityHeaders, headerConfig, safeLinkRel, integrityAttr, sriHash } from '../hasp-guard.js';
import { audit } from '../hardened.js';

const CLEAN_HTML = '<!doctype html><html lang="en"><head><title>t</title></head><body><p>ok</p></body></html>';

test('generated headers clear the auditor Tiers 1 and 2', () => {
  const headers = securityHeaders();
  const r = audit({ headers, html: CLEAN_HTML, url: 'https://x.com/' });
  assert.equal(r.tiers[1], true, `tier 1 should pass; warnings: ${r.warnings.map((w) => w.code)}`);
  assert.equal(r.tiers[2], true, `tier 2 should pass; warnings: ${r.warnings.map((w) => w.code)}`);
  assert.equal(r.ok, true);
});

test('the default CSP is effective: no unsafe-inline, no unsafe-eval, framing closed', () => {
  const c = csp();
  assert.doesNotMatch(c, /unsafe-inline/);
  assert.doesNotMatch(c, /unsafe-eval/);
  assert.match(c, /frame-ancestors 'none'/);
  assert.match(c, /object-src 'none'/);
  assert.match(c, /default-src 'self'/);
  assert.match(c, /base-uri 'self'/);
});

test('a nonce is threaded into script-src instead of opening the policy', () => {
  const c = csp({ nonce: 'abc123' });
  assert.match(c, /script-src 'self' 'nonce-abc123'/);
  assert.doesNotMatch(c, /unsafe-inline/);
});

test('script hashes are quoted and added to script-src', () => {
  const c = csp({ scriptHashes: ['sha256-AAAA', "'sha256-BBBB'"] });
  assert.match(c, /'sha256-AAAA'/);
  assert.match(c, /'sha256-BBBB'/);
});

test('allowInlineStyle without a nonce is honestly flagged by the auditor', () => {
  const headers = securityHeaders({ allowInlineStyle: true });
  assert.match(headers['Content-Security-Policy'], /style-src 'self' 'unsafe-inline'/);
  const r = audit({ headers, html: CLEAN_HTML, url: 'https://x.com/' });
  assert.equal(r.tiers[1], false);
  assert.ok(r.warnings.some((w) => w.code === 'csp-unsafe-inline'));
});

test('widening one directive does not reopen the rest', () => {
  const c = csp({ connectSrc: ["'self'", 'https://api.example.com'] });
  assert.match(c, /connect-src 'self' https:\/\/api\.example\.com/);
  assert.match(c, /default-src 'self'/);
  assert.doesNotMatch(c, /unsafe-inline/);
});

test('vercel config is valid JSON scoped to all paths with the security headers', () => {
  const out = headerConfig('vercel');
  const parsed = JSON.parse(out);
  assert.equal(parsed.headers[0].source, '/(.*)');
  const keys = parsed.headers[0].headers.map((h) => h.key);
  assert.ok(keys.includes('Content-Security-Policy'));
  assert.ok(keys.includes('Strict-Transport-Security'));
  assert.ok(keys.includes('X-Content-Type-Options'));
});

test('netlify config leads with the path and lists header lines', () => {
  const out = headerConfig('netlify');
  assert.match(out, /^\/\*\n/);
  assert.match(out, /\n {2}X-Content-Type-Options: nosniff\n/);
});

test('nginx config emits always-add_header lines', () => {
  const out = headerConfig('nginx');
  assert.match(out, /add_header Content-Security-Policy ".*" always;/);
  assert.match(out, /add_header X-Frame-Options "DENY" always;/);
});

test('an unknown target is a clear error, not a silent empty config', () => {
  assert.throws(() => headerConfig('apache'), /unknown target/);
});

test('HSTS default clears the 180-day effectiveness floor', () => {
  const secs = parseInt(/max-age=(\d+)/.exec(securityHeaders()['Strict-Transport-Security'])[1], 10);
  assert.ok(secs >= 15552000);
});

test('cross-origin isolation is opt-in', () => {
  assert.equal(securityHeaders()['Cross-Origin-Opener-Policy'], undefined);
  assert.equal(securityHeaders({ crossOriginIsolation: true })['Cross-Origin-Opener-Policy'], 'same-origin');
});

test('safeLinkRel adds noopener and noreferrer and dedupes', () => {
  assert.equal(safeLinkRel(''), 'noopener noreferrer');
  assert.equal(safeLinkRel('external noopener'), 'external noopener noreferrer');
});

test('integrityAttr formats a full attribute and passes bare digests through the algo', () => {
  assert.equal(integrityAttr('sha384-XYZ'), 'integrity="sha384-XYZ" crossorigin="anonymous"');
  assert.equal(integrityAttr('XYZ', 'sha256'), 'integrity="sha256-XYZ" crossorigin="anonymous"');
});

test('sriHash computes a sha384-prefixed digest over content', async () => {
  const h = await sriHash('console.log(1)');
  assert.match(h, /^sha384-[A-Za-z0-9+/]+=*$/);
});
