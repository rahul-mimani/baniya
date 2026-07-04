// Email delivery — provider-agnostic.
//
// Switch between Resend and Brevo via `EMAIL_PROVIDER` env var. Both have
// generous free tiers, both expose simple REST APIs. Adding more providers
// later is a matter of writing one more `sendVia*` function.
//
// Brevo is the default when EMAIL_PROVIDER=brevo because it supports verified-
// sender (no domain needed) up to 300 emails/day free. Resend remains
// available — flip `EMAIL_PROVIDER` to `resend` and fill the RESEND_* vars
// instead.

import type { Env } from '../types';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export const sendEmail = async (env: Env, args: SendArgs): Promise<void> => {
  const provider = ((env as any).EMAIL_PROVIDER || 'resend').toLowerCase();
  if (provider === 'brevo') return sendViaBrevo(env, args);
  if (provider === 'resend') return sendViaResend(env, args);
  throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
};

// ---------------------------------------------------------------------------
// Brevo (formerly Sendinblue) — https://api.brevo.com/v3/smtp/email
// ---------------------------------------------------------------------------
const sendViaBrevo = async (env: Env, args: SendArgs): Promise<void> => {
  const apiKey = (env as any).BREVO_API_KEY as string | undefined;
  const fromEmail = (env as any).EMAIL_FROM as string | undefined;
  const fromName = (env as any).EMAIL_FROM_NAME as string | undefined;

  if (!apiKey) throw new Error('BREVO_API_KEY missing in env');
  if (!fromEmail) throw new Error('EMAIL_FROM missing in env');

  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: fromName || 'Auth', email: fromEmail },
      to: [{ email: args.to }],
      subject: args.subject,
      htmlContent: args.html,
      textContent: args.text,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Brevo send failed (${r.status}): ${detail}`);
  }
};

// ---------------------------------------------------------------------------
// Resend — https://api.resend.com/emails
// ---------------------------------------------------------------------------
const sendViaResend = async (env: Env, args: SendArgs): Promise<void> => {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing in env');
  const fromEmail = (env as any).EMAIL_FROM || env.RESEND_FROM;
  const fromName = (env as any).EMAIL_FROM_NAME || env.RESEND_FROM_NAME;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Resend send failed (${r.status}): ${detail}`);
  }
};

// ---------------------------------------------------------------------------
// OTP email template — same regardless of provider.
// ---------------------------------------------------------------------------
const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const renderOtpEmail = (
  otp: string,
  ttlMinutes: number,
  recipientName: string,
  shopName = 'BillMaker',
) => {
  const subject = `Your sign-in code: ${otp.slice(0, 3)}-…`;
  const safeOtp = escapeHtml(otp);
  const safeName = escapeHtml(recipientName);
  const safeShop = escapeHtml(shopName);
  const text = [
    `Hi ${recipientName || 'there'},`,
    '',
    `Your one-time sign-in code is:    ${otp}`,
    '',
    `This code expires in ${ttlMinutes} minutes and can be used once.`,
    '',
    "If you didn't request it, ignore this email — your account stays secure.",
    '',
    `— ${shopName}`,
  ].join('\n');
  const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f7;margin:0;padding:24px;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <tr><td style="padding:24px;background:linear-gradient(135deg,#0ea5e9,#7c3aed);color:#fff;">
      <h1 style="margin:0;font-size:18px;font-weight:600;">${safeShop} · Sign-in code</h1>
    </td></tr>
    <tr><td style="padding:24px;">
      <p style="margin:0 0 12px;font-size:14px;">Hi ${safeName || 'there'},</p>
      <p style="margin:0 0 8px;font-size:14px;">Your one-time code is:</p>
      <div style="font-family:'SF Mono',Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:4px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:8px;padding:14px 18px;text-align:center;margin:12px 0;color:#0f172a;">
        ${safeOtp}
      </div>
      <p style="margin:0 0 8px;font-size:13px;color:#4b5563;">Expires in <strong>${ttlMinutes} minutes</strong>. Can be used once.</p>
      <p style="margin:24px 0 0;font-size:12px;color:#6b7280;">Didn't request this? You can safely ignore — no action needed.</p>
    </td></tr>
    <tr><td style="padding:12px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center;">
      Sent by ${safeShop} auth service · do not reply
    </td></tr>
  </table>
</body></html>`;
  return { subject, html, text };
};
