import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'crypto';
import { verifyTelegramLogin, type TelegramLoginData } from '@/lib/auth/telegram';

const BOT_TOKEN = 'test-bot-token-12345';

/**
 * Generate a valid Telegram login hash for test data.
 */
function makeTelegramData(
  overrides: Partial<TelegramLoginData> = {},
  botToken = BOT_TOKEN,
): TelegramLoginData {
  const authDate = Math.floor(Date.now() / 1000);
  const base: Omit<TelegramLoginData, 'hash'> = {
    id: 123456789,
    first_name: 'Test',
    last_name: 'User',
    username: 'testuser',
    auth_date: authDate,
    ...overrides,
  };

  const checkString = Object.entries(base)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n');

  const secretKey = createHash('sha256').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(checkString).digest('hex');

  return { ...base, hash };
}

describe('verifyTelegramLogin', () => {
  it('returns true for valid data with correct hash', () => {
    const data = makeTelegramData();
    expect(verifyTelegramLogin(data, BOT_TOKEN)).toBe(true);
  });

  it('returns false for invalid hash', () => {
    const data = makeTelegramData();
    expect(verifyTelegramLogin({ ...data, hash: 'deadbeef' }, BOT_TOKEN)).toBe(false);
  });

  it('returns false when auth_date is older than 24 hours', () => {
    const oldAuthDate = Math.floor(Date.now() / 1000) - 90000; // 25h ago
    const data = makeTelegramData({ auth_date: oldAuthDate });
    // Hash was generated for old auth_date, so hash is valid but date is expired
    // Need to regenerate hash with the old date
    const freshData = makeTelegramData({ auth_date: oldAuthDate });
    expect(verifyTelegramLogin(freshData, BOT_TOKEN)).toBe(false);
  });

  it('returns false when wrong bot token is used for verification', () => {
    const data = makeTelegramData();
    expect(verifyTelegramLogin(data, 'wrong-bot-token')).toBe(false);
  });

  it('returns true for data without optional fields', () => {
    const authDate = Math.floor(Date.now() / 1000);
    const base = {
      id: 999,
      first_name: 'NoOptionals',
      auth_date: authDate,
    };
    const checkString = Object.entries(base)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('\n');
    const secretKey = createHash('sha256').update(BOT_TOKEN).digest();
    const hash = createHmac('sha256', secretKey).update(checkString).digest('hex');
    expect(verifyTelegramLogin({ ...base, hash }, BOT_TOKEN)).toBe(true);
  });

  it('sorts fields alphabetically in check string', () => {
    // Ensure id < first_name < last_name alphabetically (i < f is wrong — f < i)
    // The sorted order: auth_date, first_name, id, last_name, username
    // If we reorder data properties, the hash should still be the same
    const data = makeTelegramData();
    const { hash, ...rest } = data;
    // Rebuild with different property order — should still validate
    const reordered = {
      username: rest.username,
      id: rest.id,
      auth_date: rest.auth_date,
      first_name: rest.first_name,
      last_name: rest.last_name,
      hash,
    } as TelegramLoginData;
    expect(verifyTelegramLogin(reordered, BOT_TOKEN)).toBe(true);
  });

  it('returns false for tampered first_name', () => {
    const data = makeTelegramData();
    expect(
      verifyTelegramLogin({ ...data, first_name: 'Hacked' }, BOT_TOKEN),
    ).toBe(false);
  });

  it('returns false for tampered id', () => {
    const data = makeTelegramData();
    expect(verifyTelegramLogin({ ...data, id: 999999 }, BOT_TOKEN)).toBe(false);
  });
});
