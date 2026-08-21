// Regression tests for the HASP client-surface hardening auditor.
// Run: node --test test/hardened.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit } from '../hardened.js';

const codes = (r) => [...r.errors, ...r.warnings].map((f) => f.code);
const has = (r, code) => codes(r).includes(code);

const GOOD_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=()',
};
const CLEAN_HTML = '<html lang="en"><head><title>t</title></head><body></body></html>';

test('a fully hardened response passes all three tiers with no findings', () => {
  const r = audit({ url: 'https://x.com/', headers: GOOD_HEADERS, html: CLEAN_HTML });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tiers, { 1: true, 2: true, 3: true });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});

test('without response headers the header tiers are undetermined, not clean', () => {
  const r = audit({ url: 'https://x.com/', html: CLEAN_HTML });
  assert.equal(r.headersChecked, false);
  assert.equal(r.tiers[1], null);
  assert.equal(r.tiers[2], null);
  assert.equal(r.tiers[3], true);
  assert.equal(r.notChecked.length, 1);
});

test('markup checks still run without headers', () => {
  const html = '<html><body><script src="https://cdn.example.com/a.js"></script><a target="_blank" href="https://evil.com">x</a></body></html>';
  const r = audit({ url: 'https://x.com/', html });
  assert.ok(has(r, 'sri-missing'));
  assert.ok(has(r, 'tabnabbing'));
});

test('invariant 1: an ineffective CSP is flagged even though it is present', () => {
  const r = audit({ headers: { 'content-security-policy': "default-src *; script-src 'unsafe-inline' 'unsafe-eval'" }, html: CLEAN_HTML });
  assert.ok(has(r, 'csp-wildcard'));
  assert.ok(has(r, 'csp-unsafe-inline'));
  assert.ok(has(r, 'csp-unsafe-eval'));
  assert.equal(r.tiers[1], false);
});

test('a CSP with a nonce is not flagged for unsafe-inline', () => {
  const r = audit({ headers: { ...GOOD_HEADERS, 'content-security-policy': "default-src 'self'; script-src 'nonce-abc123' 'unsafe-inline'; frame-ancestors 'none'" }, html: CLEAN_HTML });
  assert.ok(!has(r, 'csp-unsafe-inline'));
});

test('clickjacking: frame-ancestors * is weak, X-Frame-Options SAMEORIGIN is fine, nothing is missing', () => {
  const weak = audit({ headers: { 'content-security-policy': 'frame-ancestors *' }, html: CLEAN_HTML });
  assert.ok(has(weak, 'clickjacking-weak'));
  const xfo = audit({ headers: { ...GOOD_HEADERS, 'content-security-policy': "default-src 'self'", 'x-frame-options': 'SAMEORIGIN' }, html: CLEAN_HTML });
  assert.ok(!has(xfo, 'clickjacking-missing') && !has(xfo, 'clickjacking-weak'));
  const none = audit({ headers: { 'x-content-type-options': 'nosniff' }, html: CLEAN_HTML });
  assert.ok(has(none, 'clickjacking-missing'));
});

test('HSTS: a short max-age is weak, a missing header is missing', () => {
  assert.ok(has(audit({ headers: { 'strict-transport-security': 'max-age=100' }, html: CLEAN_HTML }), 'hsts-weak'));
  assert.ok(has(audit({ headers: { 'x-content-type-options': 'nosniff' }, html: CLEAN_HTML }), 'hsts-missing'));
});

test('nosniff must be exactly nosniff', () => {
  assert.ok(has(audit({ headers: { 'x-content-type-options': 'sniff' }, html: CLEAN_HTML }), 'nosniff-missing'));
});

test('invariant 2: a CSP only in a meta tag is flagged, not accepted', () => {
  const html = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head><body></body></html>';
  const r = audit({ headers: { 'x-content-type-options': 'nosniff' }, html });
  assert.ok(has(r, 'csp-meta-only'));
});

test('mixed content on an https page is an error; on an http page it is not checked', () => {
  const html = '<html><body><img src="http://x.com/a.png"></body></html>';
  assert.ok(has(audit({ url: 'https://x.com/', headers: GOOD_HEADERS, html }), 'mixed-content'));
  assert.ok(!has(audit({ url: 'http://x.com/', headers: GOOD_HEADERS, html }), 'mixed-content'));
});

test('an exposed secret in the body is an error', () => {
  const r = audit({ headers: GOOD_HEADERS, html: '<html><body><script>const k="sk-abcdefghijklmnopqrstuvwx1"</script></body></html>' });
  assert.equal(r.ok, false);
  assert.ok(has(r, 'exposed-secret'));
  assert.equal(r.tiers[3], false);
});

test('SRI: an external script with integrity is fine, a relative one is not flagged', () => {
  const withHash = '<html><body><script src="https://cdn.example.com/a.js" integrity="sha384-x"></script></body></html>';
  const relative = '<html><body><script src="/local/a.js"></script></body></html>';
  assert.ok(!has(audit({ headers: GOOD_HEADERS, html: withHash }), 'sri-missing'));
  assert.ok(!has(audit({ headers: GOOD_HEADERS, html: relative }), 'sri-missing'));
});

test('tabnabbing: rel=noopener clears the finding', () => {
  const safe = '<html><body><a target="_blank" rel="noopener" href="https://evil.com">x</a></body></html>';
  assert.ok(!has(audit({ headers: GOOD_HEADERS, html: safe }), 'tabnabbing'));
});

test('an oversized body is truncated and declared', () => {
  const big = '<html><body>' + 'x'.repeat(2 * 1024 * 1024 + 10) + '</body></html>';
  const r = audit({ headers: GOOD_HEADERS, html: big });
  assert.ok(r.truncated);
});
