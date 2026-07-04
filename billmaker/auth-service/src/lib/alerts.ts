// Worker error alerts — sends one email to the admin when cron ticks fail.
//
// Throttled to max ONE email per hour per shop. The first error in a
// throttle window triggers an alert; subsequent errors within that hour
// are suppressed (still logged to worker_events, just not emailed).
//
// Cost: 0 subrequests on healthy ticks, 3 on the first error in a window
// (read alert_state + send email + update alert_state). Worth the cost
// because alerts are the only signal that something is broken.
//
// Subrequest-budget caveat: if a cron tick is failing BECAUSE the
// subrequest cap was exceeded, this helper may itself fail to send the
// email. In that case the NEXT successful tick can detect "recent errors
// in worker_events" and re-attempt. We don't do that auto-retry yet — for
// now, the alert is best-effort.
//
// Usage from src/index.ts scheduled handler:
//   const report = await runIncrementalSync(env, { onlyCollections });
//   if (report.errorCount > 0) {
//     await maybeAlertOnError(env, ctx, env.SHOP_CODE, {
//       cron: event.cron, group, result: report,
//     });
//   }

import type { Env } from '../types';
import { sendEmail } from './email';
import type { SyncRunResult } from './sync';

const THROTTLE_MS = 60 * 60 * 1000; // 1 hour

export interface AlertContext {
  cron: string;
  group: string;          // 'primary' / 'secondary-A' / 'secondary-B' / 'cleanup'
  result?: SyncRunResult; // for sync ticks
  // For non-sync alerts (e.g., cleanup crash) pass a manual error blob:
  manualError?: { message: string; stack?: string };
}

/**
 * Throttled email alert. Returns true if an email was sent, false if
 * skipped (throttled, not configured, or send failed silently).
 *
 * NEVER throws — alerting is best-effort and must not crash the worker.
 */
export const maybeAlertOnError = async (
  env: Env,
  ctx: ExecutionContext,
  shopCode: string,
  alert: AlertContext,
): Promise<boolean> => {
  // Email config missing — silently skip rather than throw mid-cron.
  const recipient = env.ADMIN_EMAIL;
  if (!recipient) {
    console.warn('alert_skipped_no_admin_email');
    return false;
  }

  // Read throttle state.
  let lastAlertAt: number = 0;
  let lastSignature: string = '';
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/alert_state?shop_code=eq.${encodeURIComponent(shopCode)}&select=last_alert_at,last_alert_signature`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (r.ok) {
      const rows = await r.json() as Array<{ last_alert_at: string | null; last_alert_signature: string | null }>;
      if (rows[0]?.last_alert_at) {
        lastAlertAt = new Date(rows[0].last_alert_at).getTime();
      }
      lastSignature = rows[0]?.last_alert_signature || '';
    }
  } catch (err) {
    // If the read fails, assume not throttled (fail open — better to spam
    // once than to silently miss a real outage).
    console.warn('alert_state_read_failed', String(err));
  }

  // Build a signature for THIS alert. If same signature as last alert,
  // still throttle by time; if different, we could allow earlier — but
  // for simplicity stick to time-only throttling.
  const signature = buildSignature(alert);
  void lastSignature; // reserved for future per-signature throttling

  // Throttle: skip if within window.
  const sinceLastAlert = Date.now() - lastAlertAt;
  if (sinceLastAlert < THROTTLE_MS) {
    return false;
  }

  // Build email and send. Use ctx.waitUntil so we don't block the cron
  // tick — the email send can happen "after" the handler returns.
  const { subject, html, text } = buildEmail(shopCode, alert, env.PORTAL_URL);

  ctx.waitUntil(
    (async () => {
      try {
        await sendEmail(env, { to: recipient, subject, html, text });
      } catch (err) {
        // Don't recurse via the alert path — would loop.
        console.error('alert_send_failed', { err: String(err) });
        return;
      }

      // Update throttle state ONLY after a successful send. If send failed,
      // leaving last_alert_at unchanged means the next tick will re-attempt.
      try {
        const now = new Date().toISOString();
        const r = await fetch(
          `${env.SUPABASE_URL}/rest/v1/alert_state?on_conflict=shop_code`,
          {
            method: 'POST',
            headers: {
              apikey: env.SUPABASE_SERVICE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify([{
              shop_code: shopCode,
              last_alert_at: now,
              last_alert_signature: signature,
              // Postgres doesn't auto-increment via REST upsert easily; we
              // set count to 1 on insert and let the operator inspect manually.
              // Future: a small RPC function could increment atomically.
              alert_count: 1,
            }]),
          },
        );
        if (!r.ok) {
          console.warn('alert_state_write_failed', { status: r.status });
        }
      } catch (err) {
        console.warn('alert_state_write_threw', String(err));
      }
    })(),
  );

  return true;
};

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

const buildSignature = (alert: AlertContext): string => {
  if (alert.manualError) {
    return `crash:${alert.cron}:${alert.manualError.message.slice(0, 100)}`;
  }
  const r = alert.result;
  if (!r) return `unknown:${alert.cron}`;
  // Distinct collections with errors → signature changes if the set changes.
  const errs = r.collections
    .filter(c => c.error)
    .map(c => c.collection)
    .sort()
    .join(',');
  return `sync:${alert.cron}:${errs || 'unknown'}`;
};

const buildEmail = (shopCode: string, alert: AlertContext, portalUrl?: string): {
  subject: string;
  html: string;
  text: string;
} => {
  const cron = alert.cron;
  const group = alert.group;
  const r = alert.result;
  const manual = alert.manualError;

  const errCount = r?.errorCount ?? (manual ? 1 : 0);
  const totalCols = r?.collections?.length ?? 0;
  const startedAt = r?.startedAt ?? new Date().toISOString();
  const durationMs = r?.totalDurationMs ?? 0;

  const subject = `[BillMaker] Worker errors — ${cron} (${group}) on ${shopCode}`;

  const errorSamples = r
    ? r.collections.filter(c => c.error).slice(0, 5).map(c =>
        `  - ${c.collection}: ${c.error}`
      ).join('\n')
    : manual
      ? `  - crash: ${manual.message}`
      : '';

  const text = [
    `BillMaker worker reported errors.`,
    ``,
    `Shop:       ${shopCode}`,
    `Cron:       ${cron}`,
    `Group:      ${group}`,
    r ? `Errors:     ${errCount} / ${totalCols} collections` : `Errors:     1 (crash)`,
    `Started at: ${startedAt}`,
    `Duration:   ${durationMs} ms`,
    ``,
    `Sample errors:`,
    errorSamples || '  (none recorded)',
    ``,
    `This alert is throttled to max 1 email per hour. Subsequent errors`,
    `in the next hour are suppressed (still logged to worker_events).`,
    ...(portalUrl ? [``, `View full logs: ${portalUrl.replace(/\/$/, '')}/admin/logs`] : []),
  ].join('\n');

  const html = `
    <h2>BillMaker worker errors</h2>
    <table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd;">
      <tr><td><b>Shop</b></td><td><code>${shopCode}</code></td></tr>
      <tr><td><b>Cron</b></td><td><code>${cron}</code></td></tr>
      <tr><td><b>Group</b></td><td>${group}</td></tr>
      <tr><td><b>Errors</b></td><td>${errCount}${totalCols ? ` / ${totalCols} collections` : ''}</td></tr>
      <tr><td><b>Started at</b></td><td>${startedAt}</td></tr>
      <tr><td><b>Duration</b></td><td>${durationMs} ms</td></tr>
    </table>
    <h3>Sample errors</h3>
    <pre style="background:#f5f5f5;padding:10px;border-radius:4px;font-size:12px;">${escapeHtml(errorSamples || '(none recorded)')}</pre>
    <p style="font-size:12px;color:#666;">This alert is throttled to max 1 email per hour per shop. Subsequent errors in the next hour are suppressed (still logged to <code>worker_events</code>).</p>
    ${portalUrl ? `<p><a href="${portalUrl.replace(/\/$/, '')}/admin/logs">View full logs in admin dashboard</a></p>` : ''}
  `;

  return { subject, html, text };
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------
// Pre-tick alert sweep — fires at the START of each cron tick.
//
// Rationale: when a cron tick fails because of subrequest cap, the
// post-tick alert can't escape that same cap (it lives in the same
// invocation and shares the budget). By moving the alert check to the
// START of the NEXT tick, we have a fresh 50-subrequest budget and can
// actually send the email.
//
// Trade-off: 1-tick delay. For */2 cron that's ~2 min.
//
// What it does:
//   1. Reads worker_events for any 'error' or 'warn' level events in the
//      last 15 minutes for this shop.
//   2. If any AND alert_state.last_alert_at is null OR > 1 hour ago,
//      send a digest email summarizing the recent errors.
//   3. Updates alert_state.last_alert_at.
//
// Cost: 1 subrequest (worker_events query) on every tick + 1 (alert_state
// read) when errors found + 1 (email) + 1 (alert_state update). Worst
// case 4 subrequests per tick. Healthy ticks cost 1 subrequest extra.
// ---------------------------------------------------------------------------
export const sweepAndAlert = async (
  env: Env,
  ctx: ExecutionContext,
  shopCode: string,
): Promise<void> => {
  const recipient = env.ADMIN_EMAIL;
  if (!recipient) return;

  // 1. Look for recent errors/warnings in worker_events.
  let recentErrors: Array<{ ts: string; event: string; payload: any }> = [];
  try {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/worker_events?shop_code=eq.${encodeURIComponent(shopCode)}` +
      `&level=in.(error,warn)&ts=gt.${encodeURIComponent(since)}` +
      `&select=ts,event,payload&order=ts.desc&limit=10`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (r.ok) {
      recentErrors = await r.json() as typeof recentErrors;
    }
  } catch {
    // Silent fail — don't crash the cron because the sweep didn't work.
    return;
  }

  if (recentErrors.length === 0) return; // no errors → nothing to alert

  // 2. Check throttle.
  let lastAlertAt = 0;
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/alert_state?shop_code=eq.${encodeURIComponent(shopCode)}&select=last_alert_at`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (r.ok) {
      const rows = await r.json() as Array<{ last_alert_at: string | null }>;
      if (rows[0]?.last_alert_at) {
        lastAlertAt = new Date(rows[0].last_alert_at).getTime();
      }
    }
  } catch {
    // Fail open — proceed to alert.
  }

  if (Date.now() - lastAlertAt < THROTTLE_MS) return;

  // 3. Send digest email. ctx.waitUntil lets the send happen "after" the
  // cron handler returns — but still within this invocation, sharing the
  // remaining subrequest budget.
  const { subject, html, text } = buildDigestEmail(shopCode, recentErrors, env.PORTAL_URL);

  ctx.waitUntil(
    (async () => {
      try {
        await sendEmail(env, { to: recipient, subject, html, text });
      } catch (err) {
        console.error('sweep_alert_send_failed', { err: String(err) });
        return;
      }
      try {
        const now = new Date().toISOString();
        await fetch(
          `${env.SUPABASE_URL}/rest/v1/alert_state?on_conflict=shop_code`,
          {
            method: 'POST',
            headers: {
              apikey: env.SUPABASE_SERVICE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify([{
              shop_code: shopCode,
              last_alert_at: now,
              last_alert_signature: `sweep:${recentErrors[0].event}`,
              alert_count: 1,
            }]),
          },
        );
      } catch (err) {
        console.warn('sweep_alert_state_write_failed', String(err));
      }
    })(),
  );
};

const buildDigestEmail = (
  shopCode: string,
  errors: Array<{ ts: string; event: string; payload: any }>,
  portalUrl?: string,
): { subject: string; html: string; text: string } => {
  const errorCount = errors.length;
  const oldestTs = errors[errors.length - 1]?.ts ?? '';
  const newestTs = errors[0]?.ts ?? '';

  const subject = `[BillMaker] ${errorCount} worker error(s) on ${shopCode}`;

  const samples = errors.slice(0, 5).map(e => {
    const cron = e.payload?.cron || 'unknown';
    const err = e.payload?.err || e.payload?.error || JSON.stringify(e.payload).slice(0, 150);
    return `  [${e.ts}] ${e.event} (${cron}): ${err}`;
  }).join('\n');

  const text = [
    `BillMaker worker reported ${errorCount} error(s) in the last 15 minutes.`,
    ``,
    `Shop:    ${shopCode}`,
    `Oldest:  ${oldestTs}`,
    `Newest:  ${newestTs}`,
    ``,
    `Recent events:`,
    samples,
    ``,
    `This is a digest alert. Throttled to max 1 email per hour.`,
    ...(portalUrl ? [`View full logs: ${portalUrl.replace(/\/$/, '')}/admin/logs`] : []),
  ].join('\n');

  const html = `
    <h2>BillMaker worker errors</h2>
    <p>${errorCount} error(s) detected in the last 15 minutes.</p>
    <table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd;">
      <tr><td><b>Shop</b></td><td><code>${shopCode}</code></td></tr>
      <tr><td><b>Oldest</b></td><td>${oldestTs}</td></tr>
      <tr><td><b>Newest</b></td><td>${newestTs}</td></tr>
    </table>
    <h3>Recent events</h3>
    <pre style="background:#f5f5f5;padding:10px;border-radius:4px;font-size:12px;">${escapeHtml(samples)}</pre>
    <p style="font-size:12px;color:#666;">Digest alert. Throttled to max 1 email per hour.</p>
    ${portalUrl ? `<p><a href="${portalUrl.replace(/\/$/, '')}/admin/logs">View full logs in admin dashboard</a></p>` : ''}
  `;

  return { subject, html, text };
};
