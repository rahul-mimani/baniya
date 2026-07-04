// Worker event logger. Every call does two things:
//   1. console.log/warn/error — so Cloudflare's native Workers Logs (level 1
//      observability) still captures it for ad-hoc debugging.
//   2. Fire-and-forget insert into Supabase `worker_events` — so the admin
//      dashboard's /admin/logs Worker tab has persistent, queryable history
//      that survives the 24h Cloudflare retention limit.
//
// Uses ctx.waitUntil() so the Supabase write doesn't block the response. If
// Supabase is down or rejects, console.log still went through — we never
// crash the worker because log persistence failed.
//
// Usage:
//   const logger = createEventLogger(env, ctx, env.SHOP_CODE);
//   logger.info('sync_completed', { durationMs: 1234, errorCount: 0 });

import type { Env } from '../types';

export type LogLevel = 'info' | 'warn' | 'error';

export interface EventLogger {
  info: (event: string, payload?: object) => void;
  warn: (event: string, payload?: object) => void;
  error: (event: string, payload?: object) => void;
}

export const createEventLogger = (
  env: Env,
  ctx: ExecutionContext,
  shopCode: string,
): EventLogger => {
  const enabled = !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);

  const push = (level: LogLevel, event: string, payload: object | undefined) => {
    // 1. Always console-log first — that's the cheap, can't-fail surface.
    const data = payload ?? {};
    if (level === 'error') console.error(event, data);
    else if (level === 'warn') console.warn(event, data);
    else console.log(event, data);

    if (!enabled) return;

    // 2. Persist to Supabase via REST. waitUntil lets this complete after
    //    the response is sent (no latency penalty on user-facing requests).
    const body = JSON.stringify({
      shop_code: shopCode,
      level,
      event,
      payload: data,
    });

    ctx.waitUntil(
      fetch(`${env.SUPABASE_URL}/rest/v1/worker_events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: env.SUPABASE_SERVICE_KEY!,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          // Prefer minimal response — we don't need the inserted row back.
          Prefer: 'return=minimal',
        },
        body,
      })
        .then(r => {
          if (!r.ok) {
            // Don't recurse via this logger — would loop. Just console.error.
            console.error('event_log_push_failed', {
              status: r.status,
              event,
              level,
            });
          }
        })
        .catch(err => {
          console.error('event_log_push_threw', { event, err: String(err) });
        }),
    );
  };

  return {
    info: (event, payload) => push('info', event, payload),
    warn: (event, payload) => push('warn', event, payload),
    error: (event, payload) => push('error', event, payload),
  };
};
