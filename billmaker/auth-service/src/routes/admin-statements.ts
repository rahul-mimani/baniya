// /admin/statements — send pre-rendered statement PDFs to customers via email.
//
// The web-portal generates one PDF per customer (using pdf-lib in the browser)
// and POSTs the batch here as base64. The worker fans out one Brevo API call
// per recipient — Brevo supports attachments natively, so we just wrap the
// PDF and HTML body and ship.
//
// We deliberately do NOT use the shared sendEmail helper because adding
// attachment support there risks regressing the OTP flow. The Brevo call is
// inlined here for isolation.
//
// Endpoint:
//   POST /admin/statements/send
//   Body: { items: [{ to, name, subject, html, text?, pdfBase64, fileName }, ...] }
//   → { sent: number, failed: number, results: [{ to, ok, error? }, ...] }

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth, requireAdmin } from '../lib/middleware';
import { createEventLogger } from '../lib/eventLog';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth, requireAdmin);

interface StatementEmailItem {
  to: string;
  name: string;          // recipient display name, used as personalization
  subject: string;
  html: string;
  text?: string;
  pdfBase64: string;     // base64-encoded PDF (no data: prefix)
  fileName: string;      // e.g. "statement-acme-may-2026.pdf"
}

interface SendResult {
  to: string;
  ok: boolean;
  error?: string;
}

const MAX_BATCH = 20;    // matches Cloudflare's free-tier 50-subrequest budget
                         // with comfortable headroom for retries / overhead.

app.post('/send', async c => {
  const apiKey = (c.env as any).BREVO_API_KEY as string | undefined;
  const fromEmail = (c.env as any).EMAIL_FROM as string | undefined;
  const fromName = ((c.env as any).EMAIL_FROM_NAME || c.env.SHOP_NAME) as string | undefined;

  if (!apiKey) {
    return c.json({ error: 'brevo_not_configured', reason: 'BREVO_API_KEY missing in worker env' }, 503);
  }
  if (!fromEmail) {
    return c.json({ error: 'sender_not_configured', reason: 'EMAIL_FROM missing in worker env' }, 503);
  }

  let body: { items?: StatementEmailItem[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    return c.json({ error: 'no_items' }, 400);
  }
  if (items.length > MAX_BATCH) {
    return c.json(
      {
        error: 'batch_too_large',
        max: MAX_BATCH,
        received: items.length,
        hint: 'Split into multiple requests of up to 20 recipients each.',
      },
      400,
    );
  }

  // Validate every item up front so a bad row doesn't surface mid-batch.
  for (const [i, it] of items.entries()) {
    if (!it || typeof it !== 'object') {
      return c.json({ error: 'invalid_item', index: i }, 400);
    }
    if (!it.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(it.to)) {
      return c.json({ error: 'invalid_email', index: i, to: it.to }, 400);
    }
    if (!it.subject || !it.html || !it.pdfBase64 || !it.fileName) {
      return c.json({ error: 'missing_fields', index: i }, 400);
    }
  }

  const logger = createEventLogger(c.env, c.executionCtx, c.env.SHOP_CODE);

  // Send sequentially. Brevo doesn't penalize for back-to-back calls at this
  // volume (20 max). Sequential makes per-item error reporting clean.
  const results: SendResult[] = [];
  for (const it of items) {
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { name: fromName || 'Baniya', email: fromEmail },
          to: [{ email: it.to, name: it.name }],
          subject: it.subject,
          htmlContent: it.html,
          textContent: it.text,
          attachment: [
            { name: it.fileName, content: it.pdfBase64 },
          ],
          tags: ['statement', `shop:${c.env.SHOP_CODE}`],
        }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        results.push({ to: it.to, ok: false, error: `brevo ${r.status}: ${detail.slice(0, 200)}` });
      } else {
        results.push({ to: it.to, ok: true });
      }
    } catch (err) {
      results.push({ to: it.to, ok: false, error: String(err) });
    }
  }

  const sent = results.filter(r => r.ok).length;
  const failed = results.length - sent;

  // Log a single summary event (avoids hammering the worker_events table
  // with per-recipient rows — admin can see failures in the response).
  logger[failed > 0 ? 'warn' : 'info']('statements_sent', {
    sent,
    failed,
    recipients: results.length,
    failedAddresses: results.filter(r => !r.ok).map(r => r.to),
  });

  return c.json({ sent, failed, results });
});

export default app;
