import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

// Resolve the package used by the API's actual Nest/Express consumer chain.
const api = createRequire(resolve('apps/api/package.json'));
const nest = createRequire(api.resolve('@nestjs/platform-express'));
const express = createRequire(nest.resolve('express'));
const proxyaddr = express('proxy-addr');
const request = (remoteAddress, forwarded) => ({
  socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded },
});

test('short IPv6 subnet prefixes cannot trust arbitrary IPv4 clients', () => {
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(proxyaddr(request('203.0.113.8', '192.0.2.99'), trust), '203.0.113.8');
  }
});

test('explicit IPv4 and fully mapped subnets retain legitimate proxy behavior', () => {
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(proxyaddr(request('10.1.2.3', '198.51.100.25'), trust), '198.51.100.25');
    assert.equal(proxyaddr(request('203.0.113.8', '192.0.2.99'), trust), '203.0.113.8');
  }
});
