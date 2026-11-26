import { describe, expect, it } from 'vitest';

import { externalImageHost } from './external-image';

const own = ['https://brain.example.com', 'http://localhost:3000'];
const base = 'https://brain.example.com/notes/a';

describe('externalImageHost', () => {
  it('names the site of an image on another origin', () => {
    expect(externalImageHost('https://elsewhere.example/p.png?d=x', own, base)).toBe('elsewhere.example');
  });

  it('treats a protocol-relative URL as external', () => {
    expect(externalImageHost('//elsewhere.example/p.png', own, base)).toBe('elsewhere.example');
  });

  it('treats another port or scheme of our own host as external', () => {
    expect(externalImageHost('http://brain.example.com/p.png', own, base)).toBe('brain.example.com');
    expect(externalImageHost('https://brain.example.com:8443/p.png', own, base)).toBe('brain.example.com:8443');
  });

  it('lets our own origins through, relative paths included', () => {
    expect(externalImageHost('/api/files/a.png', own, base)).toBeNull();
    expect(externalImageHost('a.png', own, base)).toBeNull();
    expect(externalImageHost('https://brain.example.com/api/a.png', own, base)).toBeNull();
    expect(externalImageHost('http://localhost:3000/api/a.png', own, base)).toBeNull();
  });

  it('ignores schemes the browser does not fetch over the network', () => {
    expect(externalImageHost('embed://a.png', own, base)).toBeNull();
  });

  it('holds what it cannot parse', () => {
    expect(externalImageHost('http://[bad', own, base)).toBe('http://[bad');
  });
});
