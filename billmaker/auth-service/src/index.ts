// Worker entry. Hono router with global middleware.
//
// Mount points:
//   /auth/*    — request-otp, verify-otp, me, logout
//   /admin/*   — admin-only routes (bootstrap, users CRUD)
//
// Every response gets restrictive security headers. CORS is enforced per-origin.

import { Hono } from 'hono';
import authRoutes from './routes/auth';
import mobileRoutes from './routes/mobile';
import clientRoutes from './routes/client';
import adminUsersRoutes from './routes/admin-users';
import adminBootstrapRoutes from './routes/admin-bootstrap';
import adminSyncRoutes from './routes/admin-sync';
import adminShopRoutes from './routes/admin-shop';
import adminQuotesRoutes from './routes/admin-quotes';
import adminReprintsRoutes from './routes/admin-reprints';
import adminUsageRoutes from './routes/admin-usage';
import adminWorkerEventsRoutes from './routes/admin-worker-events';
import adminStatementsRoutes from './routes/admin-statements';
import { cors, installLogRedaction } from './lib/middleware';
import { runIncrementalSync, runWeeklyCleanup } from './lib/sync';
import { createEventLogger } from './lib/eventLog';
import type { Env, Variables } from './types';

// Install log redaction once at module load. Worker reuses isolates across
// requests, so this only runs once per cold-start.
installLogRedaction();

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---- global middleware ----
app.use('*', cors);

app.use('*', async (c, next) => {
  await next();
  // Security headers on every response
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.res.headers.set('Cache-Control', 'no-store');
});

// ---- routes ----
app.get('/', c => c.json({ service: 'billmaker-auth', status: 'ok' }));
app.get('/healthz', c => c.json({ ok: true, ts: new Date().toISOString() }));

app.route('/auth', authRoutes);
// Phase B mobile (Baniya shopkeeper app) endpoints. Mounted under
// /mobile to keep them strictly separate from the OTP-auth flows in /auth.
app.route('/mobile', mobileRoutes);
app.route('/client', clientRoutes);
app.route('/admin', adminBootstrapRoutes);
app.route('/admin/users', adminUsersRoutes);
app.route('/admin/sync', adminSyncRoutes);
app.route('/admin/shop', adminShopRoutes);
app.route('/admin/quotes', adminQuotesRoutes);
app.route('/admin/reprints', adminReprintsRoutes);
app.route('/admin/usage', adminUsageRoutes);
app.route('/admin/worker-events', adminWorkerEventsRoutes);
app.route('/admin/statements', adminStatementsRoutes);

// ---- fallbacks ----
app.notFound(c => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  console.error('unhandled', { err: String(err), stack: (err as Error)?.stack });
  return c.json({ error: 'internal_error' }, 500);
});

// Cloudflare Workers expect a default export with `fetch` and (optionally)
// `scheduled`. wrangler.toml defines three cron triggers — dispatch by cron
// expression. Reconcile is admin-triggered only.
//
// SYNC is split into two crons so each invocation stays under Cloudflare
// Workers' free-tier subrequest cap (50/invocation):
//   - Primary (every 2 min): mobile-critical bills + customer name registry
//     + _meta (admin_aggregates).
//   - Secondary (every 5 min): admin-managed portal collections + products
//     name registry + profiles.
//
// Note: cron is the SAFETY NET. The hot paths (bills, payments, ack) are
// already pushed to Supabase in ~1s via /mobile/sync/trigger/bills and the
// portal's per-action triggers. The cron exists to catch missed triggers,
// admin writes that don't trigger, and direct-edit cases.
const CLEANUP_CRON = '0 3 * * SUN';
const SYNC_PRIMARY_CRON = '*/2 * * * *';
const SYNC_SECONDARY_CRON = '*/5 * * * *';

// Mobile-critical. Synced on primary cron.
//   - bills:     hot path — mobile bill writes, ack toggles, payments
//   - customers: mobile autocomplete (legacy name registry written by mobile
//                via worker derive + admin via syncCustomerNameToMobile)
//   - _meta:     admin_aggregates doc + business profile
//   ('payments' RETIRED in Deploy 5 — embedded in bills.payments[] now)
const COLLECTIONS_PRIMARY = [
  'bills',
  'customers',
  '_meta',
] as const;

// Admin-managed + products name registry. Synced on secondary cron.
// Split into two subsets that alternate on */5 ticks so each invocation
// stays under Workers free-tier 10ms CPU cap. Each collection still syncs
// every 10 minutes (not 5), which is fine for these admin-managed sources.
//
// Subset A (fires on minute % 10 === 0, e.g., :00, :10, :20, :30, :40, :50):
//   - products:         mobile autocomplete (legacy name registry)
//   - portal_customers: admin-managed; client API + admin dashboard read
//   - portal_products:  admin-managed catalog
//
// Subset B (fires on minute % 10 !== 0, e.g., :05, :15, :25, :35, :45, :55):
//   - profiles:         mobile profile dropdown
//   - portal_labels, portal_classes, portal_deals: admin metadata (rarely change)
const COLLECTIONS_SECONDARY_A = [
  'products',
  'portal_customers',
  'portal_products',
] as const;

const COLLECTIONS_SECONDARY_B = [
  'profiles',
  'portal_labels',
  'portal_classes',
  'portal_deals',
] as const;

// Secondary-shop profile: one */2 cron does ALL the sync work via
// HOT (every tick) + 1 rotating COLD collection per tick. Fits under
// free-tier 10ms CPU + 50 subrequest caps. Used by any worker whose
// env.WORKER_PROFILE === "secondary" (i.e., non-primary shop deployments
// like billmaker-auth-shop2).
const SECONDARY_SHOP_HOT = [
  'bills',            // mobile bill writes + admin ack/payment ops
  'customers',        // mobile autocomplete (worker-derived from bills)
  '_meta',            // admin_aggregates dashboard values
  'portal_customers', // client login depends on this — must be fresh
] as const;

const SECONDARY_SHOP_COLD = [
  'products',         // mobile product autocomplete
  'portal_products',  // admin catalog
  'portal_labels',    // admin metadata, rare
  'portal_classes',   // admin metadata, rare
  'portal_deals',     // admin promos, rare
  'profiles',         // mobile profile dropdown, rare
] as const;
// Cold cycle = 6 collections × 2 min/tick = 12 min full rotation

export default {
  fetch: app.fetch,
  scheduled: async (
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> => {
    // Structured logger — writes to Cloudflare native logs AND persists to
    // Supabase worker_events for the admin dashboard's /admin/logs tab.
    const logger = createEventLogger(env, ctx, env.SHOP_CODE);

    // BEFORE the main work: check for previous-tick errors and alert.
    // This runs with a FRESH subrequest budget — even if the PREVIOUS tick
    // exhausted its budget and couldn't send an alert about its own failure,
    // this tick has budget to send a digest email about it.
    // Cost: ~1 subrequest when no errors, ~4 when alert fires. Throttled to
    // 1 email per hour per shop. Best-effort — never throws.
    try {
      const { sweepAndAlert } = await import('./lib/alerts');
      await sweepAndAlert(env, ctx, env.SHOP_CODE);
    } catch (err) {
      // Don't let the sweep block the actual cron work.
      console.warn('sweep_alert_top_level_failed', String(err));
    }

    // Weekly cleanup — Sunday 03:00 UTC. Prunes expired OTPs + old sessions.
    if (event.cron === CLEANUP_CRON) {
      ctx.waitUntil(
        runWeeklyCleanup(env)
          .then(async result => {
            logger.info('cleanup_completed', { cron: event.cron, ...result });
            if (result.error) {
              const { maybeAlertOnError } = await import('./lib/alerts');
              await maybeAlertOnError(env, ctx, env.SHOP_CODE, {
                cron: event.cron,
                group: 'cleanup',
                manualError: { message: result.error },
              });
            }
          })
          .catch(async err => {
            logger.error('cleanup_crashed', { cron: event.cron, err: String(err) });
            const { maybeAlertOnError } = await import('./lib/alerts');
            await maybeAlertOnError(env, ctx, env.SHOP_CODE, {
              cron: event.cron,
              group: 'cleanup',
              manualError: { message: String(err), stack: (err as Error)?.stack },
            });
          }),
      );
      return;
    }

    // Sync dispatch.
    //
    // SECONDARY-PROFILE WORKER (env.WORKER_PROFILE === "secondary")
    //   - One */2 cron does everything via HOT + 1 rotating COLD.
    //   - Used by smaller per-shop worker deployments (e.g. shop2) where
    //     allocating 3 separate cron slots would burn through Cloudflare's
    //     5-trigger-per-account free-tier cap.
    //
    // PRIMARY-PROFILE WORKER (default — WORKER_PROFILE absent or "primary")
    //   - Existing 3-cron split: */2 (hot), */5 (admin), Sunday cleanup.
    //   - Used by the main shop deployment.
    let collectionsToSync: readonly string[];
    let group: 'primary' | 'secondary-A' | 'secondary-B' | 'secondary-rotating';

    if (env.WORKER_PROFILE === 'secondary') {
      // The secondary worker only registers the */2 cron. Anything else is
      // unexpected — fall back to syncing the HOT set safely.
      if (event.cron !== SYNC_PRIMARY_CRON) {
        logger.warn('secondary_unexpected_cron', { cron: event.cron });
      }
      // Pick which cold collection runs this tick. Each tick of */2 advances
      // the cold index by 1; with 6 cold collections, each cycles every 12 min.
      const minute = new Date(event.scheduledTime).getUTCMinutes();
      const tickIdx = Math.floor(minute / 2);
      const coldSlot = SECONDARY_SHOP_COLD[tickIdx % SECONDARY_SHOP_COLD.length];
      collectionsToSync = [...SECONDARY_SHOP_HOT, coldSlot];
      group = 'secondary-rotating';
    } else if (event.cron === SYNC_SECONDARY_CRON) {
      // Primary worker's */5 cron — split admin-managed collections across
      // alternating ticks to stay under the 10ms CPU cap.
      const minute = new Date(event.scheduledTime).getUTCMinutes();
      if (minute % 10 === 0) {
        collectionsToSync = COLLECTIONS_SECONDARY_A;
        group = 'secondary-A';
      } else {
        collectionsToSync = COLLECTIONS_SECONDARY_B;
        group = 'secondary-B';
      }
    } else if (event.cron === SYNC_PRIMARY_CRON) {
      collectionsToSync = COLLECTIONS_PRIMARY;
      group = 'primary';
    } else {
      logger.warn('unknown_cron_defaulting_to_primary', { cron: event.cron });
      collectionsToSync = COLLECTIONS_PRIMARY;
      group = 'primary';
    }

    ctx.waitUntil(
      runIncrementalSync(env, { onlyCollections: collectionsToSync })
        .then(async result => {
          const level = result.errorCount > 0 ? 'warn' : 'info';
          logger[level]('sync_completed', {
            cron: event.cron,
            group,
            mode: result.mode,
            shopCode: result.shopCode,
            durationMs: result.totalDurationMs,
            errorCount: result.errorCount,
            collections: result.collections.map(c => ({
              name: c.collection,
              mode: c.mode,
              docs: c.docCount,
              ...(c.deletedCount !== undefined ? { deleted: c.deletedCount } : {}),
              ms: c.durationMs,
              ...(c.error ? { error: c.error } : {}),
            })),
          });

          // Email the admin if anything failed this tick. Throttled to max
          // 1 email per hour per shop — see lib/alerts.ts.
          if (result.errorCount > 0) {
            const { maybeAlertOnError } = await import('./lib/alerts');
            await maybeAlertOnError(env, ctx, env.SHOP_CODE, {
              cron: event.cron,
              group,
              result,
            });
          }
        })
        .catch(async err => {
          logger.error('sync_crashed', {
            cron: event.cron,
            group,
            err: String(err),
            stack: (err as Error)?.stack,
          });
          // Cron handler threw — also alert (crashes are worse than per-
          // collection errors). Same hourly throttle applies.
          const { maybeAlertOnError } = await import('./lib/alerts');
          await maybeAlertOnError(env, ctx, env.SHOP_CODE, {
            cron: event.cron,
            group,
            manualError: { message: String(err), stack: (err as Error)?.stack },
          });
        }),
    );
  },
};
