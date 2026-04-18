import { createHmac, createHash } from 'crypto';

export interface TelegramLoginData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

/**
 * Verify Telegram Login Widget data per official spec:
 * https://core.telegram.org/widgets/login#checking-authorization
 *
 * 1. Build data-check-string: sorted key=value pairs (excluding hash), joined by \n
 * 2. secret_key = SHA256(bot_token)
 * 3. HMAC-SHA256(data_check_string, secret_key) must equal hash
 * 4. auth_date must be within 24 hours
 */
export function verifyTelegramLogin(data: TelegramLoginData, botToken: string): boolean {
  const { hash, ...rest } = data;

  // Build data-check-string
  const checkString = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n');

  // secret_key = SHA256(bot_token)
  const secretKey = createHash('sha256').update(botToken).digest();

  // HMAC-SHA256(data_check_string, secret_key)
  const computed = createHmac('sha256', secretKey).update(checkString).digest('hex');

  if (computed !== hash) {
    return false;
  }

  // Check auth_date is within 24 hours
  const now = Math.floor(Date.now() / 1000);
  const age = now - data.auth_date;
  if (age > 86400) {
    return false;
  }

  return true;
}
