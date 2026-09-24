// A2-255: the bind address is a security boundary, so it is a tested value and not a default
// buried in a framework call. Before this, `app.listen(port)` bound every interface, and on a mesh
// host that published the API to every peer (A2-251 §6, measured on arcana-devs).

import { ANY_IPV4, bindsEveryInterface, resolveBindHost } from '../src/bind-host.js';

describe('resolveBindHost', () => {
  it('defaults to IPv4 loopback when HOST is unset', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
  });

  it('treats an empty or whitespace HOST as unset rather than as "any interface"', () => {
    // A template that renders `HOST=` from an unset variable must not open the service up; an
    // empty string handed to listen() is the wildcard, which is the opposite of what was asked.
    expect(resolveBindHost({ HOST: '' })).toBe('127.0.0.1');
    expect(resolveBindHost({ HOST: '   ' })).toBe('127.0.0.1');
  });

  it('honours an explicit address, including the wildcard the container needs', () => {
    expect(resolveBindHost({ HOST: ANY_IPV4 })).toBe('0.0.0.0');
    expect(resolveBindHost({ HOST: '10.0.0.13' })).toBe('10.0.0.13');
    expect(resolveBindHost({ HOST: ' 0.0.0.0 ' })).toBe('0.0.0.0');
  });

  it('labels only the wildcard forms as binding every interface', () => {
    expect(bindsEveryInterface('0.0.0.0')).toBe(true);
    expect(bindsEveryInterface('::')).toBe(true);
    expect(bindsEveryInterface('127.0.0.1')).toBe(false);
    expect(bindsEveryInterface('10.0.0.13')).toBe(false);
  });
});
