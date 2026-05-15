import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';

import { ApiKeyService } from './ApiKeyService.js';
import { AuthService } from './AuthService.js';
import { CapturingEmailSender } from './EmailSender.js';

const logger = pino({ level: 'silent' });

let bs: BrainStackDatabase;
let auth: AuthService;
let apiKeys: ApiKeyService;
let mailer: CapturingEmailSender;
let now = 1_700_000_000_000;

beforeEach(() => {
  bs = openDatabase(':memory:');
  mailer = new CapturingEmailSender();
  now = 1_700_000_000_000;
  auth = new AuthService({
    db: bs,
    email: mailer,
    logger,
    publicOrigin: 'https://brain.test',
    authorizedEmails: new Set(['user@brain.test']),
    now: () => now,
  });
  apiKeys = new ApiKeyService({ db: bs, now: () => now });
});

afterEach(() => {
  bs.close();
});

describe('AuthService sessions', () => {
  it('creates, validates and revokes a session', () => {
    const user = auth.ensureUser('user@brain.test');
    const session = auth.createSession(user.id);
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);

    const validated = auth.validateSession(session.token);
    expect(validated?.id).toBe(user.id);

    auth.revokeSession(session.token);
    expect(auth.validateSession(session.token)).toBeNull();
  });
});

describe('ApiKeyService', () => {
  it('creates a key that validates by token and is shown only once', () => {
    const user = auth.ensureUser('user@brain.test');
    const created = apiKeys.create(user.id, 'Claude Code', ['notes:read']);
    expect(created.token).toMatch(/^bs_/);
    expect(created.prefix).toBe(created.token.slice(0, 9));

    const validated = apiKeys.validate(created.token);
    expect(validated?.id).toBe(created.id);
    expect(validated?.scopes).toEqual(['notes:read']);
  });

  it('returns null on invalid or revoked tokens', () => {
    const user = auth.ensureUser('user@brain.test');
    const created = apiKeys.create(user.id, 'Test');
    apiKeys.revoke(created.id);
    expect(apiKeys.validate(created.token)).toBeNull();
    expect(apiKeys.validate('bs_invalid')).toBeNull();
  });

  it('lists keys for a user, newest first', () => {
    const user = auth.ensureUser('user@brain.test');
    apiKeys.create(user.id, 'Old');
    now += 1000;
    apiKeys.create(user.id, 'New');
    const list = apiKeys.list(user.id);
    expect(list.map((k) => k.name)).toEqual(['New', 'Old']);
  });
});
