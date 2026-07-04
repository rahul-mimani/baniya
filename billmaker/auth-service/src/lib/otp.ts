// OTP generation + hashing.
//
// Format: `ABC-DEFG` (3 + 4 alphanumeric uppercase, excluding visually
// confusing chars). The first 3 chars are the "prefix" — shown back to the
// user immediately after requesting so they can match the email against the
// portal screen ("your code starts with ABC-..."). The full 7-char code goes
// to the email; only the prefix is returned over HTTP.

import { pbkdf2Hash, pbkdf2Verify, randomBytes } from './crypto';

// Excludes 0/O, 1/I/L to reduce typo-confusion. 32 chars.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const pickChar = (): string => {
  // crypto.getRandomValues uniform over [0, 256). We map mod len with rejection
  // of the highest residue class to avoid bias.
  const len = ALPHABET.length;
  const limit = 256 - (256 % len);
  for (;;) {
    const b = randomBytes(1)[0];
    if (b < limit) return ALPHABET[b % len];
  }
};

export const generateOtp = (): { prefix: string; secret: string; full: string } => {
  let prefix = '';
  for (let i = 0; i < 3; i++) prefix += pickChar();
  let secret = '';
  for (let i = 0; i < 4; i++) secret += pickChar();
  return { prefix, secret, full: `${prefix}-${secret}` };
};

/** Normalise user input: uppercase, strip whitespace + dashes for comparison. */
export const normalizeOtp = (s: string): string => s.replace(/[\s-]/g, '').toUpperCase();

export const hashOtp = (otp: string, pepper: string): Promise<string> =>
  pbkdf2Hash(normalizeOtp(otp), pepper);

export const verifyOtp = (otp: string, pepper: string, stored: string): Promise<boolean> =>
  pbkdf2Verify(normalizeOtp(otp), pepper, stored);
