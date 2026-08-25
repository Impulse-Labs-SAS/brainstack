// The pure helpers of the OAuth provider: which redirect URIs are allowed and
// how a requested scope is narrowed. These carry security weight on their own,
// so they get their own table-driven checks apart from the HTTP flow.

import { describe, expect, it } from 'vitest';

import { isAllowedRedirectUri, narrowScope, pkceChallengeFrom } from './OAuthProviderService.js';

describe('isAllowedRedirectUri', () => {
  it('accepts https anywhere', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
  });

  it('accepts loopback http and refuses named-host http', () => {
    expect(isAllowedRedirectUri('http://127.0.0.1:33418/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://evil.test/cb')).toBe(false);
  });

  it('accepts private-use schemes for native clients', () => {
    expect(isAllowedRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(true);
    expect(isAllowedRedirectUri('vscode://ms-vscode.cpptools/auth')).toBe(true);
  });

  it('refuses schemes that would execute or exfiltrate', () => {
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isAllowedRedirectUri('data:text/html,<script>')).toBe(false);
    expect(isAllowedRedirectUri('file:///etc/passwd')).toBe(false);
  });

  it('refuses garbage', () => {
    expect(isAllowedRedirectUri('not a url')).toBe(false);
    expect(isAllowedRedirectUri('')).toBe(false);
  });
});

describe('narrowScope', () => {
  it('defaults an empty request to the base scope', () => {
    expect(narrowScope(undefined)).toBe('mcp');
    expect(narrowScope('')).toBe('mcp');
    expect(narrowScope('   ')).toBe('mcp');
  });

  it('keeps only granted scopes', () => {
    expect(narrowScope('mcp')).toBe('mcp');
    expect(narrowScope('mcp openid profile')).toBe('mcp');
  });

  it('falls back to the base scope when nothing requested is granted', () => {
    expect(narrowScope('openid profile email')).toBe('mcp');
  });
});

describe('pkceChallengeFrom', () => {
  it('produces the RFC 7636 S256 value', () => {
    // Vector from RFC 7636 Appendix B.
    expect(pkceChallengeFrom('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
