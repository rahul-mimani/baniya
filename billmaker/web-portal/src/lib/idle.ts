// Idle detection — module-level state + hook.
//
// Purpose: after N minutes of no user activity, mark the client app as "idle"
// so background fetches can pause and save backend resources. When the user
// returns (clicks the resume button, or any tab-focus event re-arms us), we
// flip back to active and trigger a refetch.
//
// Listened events: mousemove, keydown, touchstart, scroll, visibilitychange.
// Each one resets the inactivity timer.
//
// Anyone needing to know if the app is idle calls `useIdle()` or reads
// `isIdle()` directly. Anyone needing to PREVENT a request while idle should
// gate on `isIdle()` and re-trigger from the resume path.

import { useEffect, useState } from 'react';

const IDLE_AFTER_MS = 10 * 60_000; // 10 minutes

let idle = false;
let lastActivity = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<(idle: boolean) => void>();
const resumeSubs = new Set<() => void>();
let listenersAttached = false;

const notify = () => { for (const fn of subs) { try { fn(idle); } catch {} } };
const notifyResume = () => { for (const fn of resumeSubs) { try { fn(); } catch {} } };

const setIdle = (next: boolean) => {
  if (idle === next) return;
  const wasIdle = idle;
  idle = next;
  notify();
  if (wasIdle && !next) notifyResume();
};

const armTimer = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => setIdle(true), IDLE_AFTER_MS);
};

const onActivity = () => {
  lastActivity = Date.now();
  if (idle) {
    // User pressed/clicked/typed → exit idle automatically.
    setIdle(false);
  }
  armTimer();
};

const onVisibility = () => {
  if (document.visibilityState === 'visible') {
    // Returning from a hidden tab counts as activity.
    onActivity();
  }
};

const attachListenersOnce = () => {
  if (listenersAttached) return;
  listenersAttached = true;
  const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'] as const;
  for (const ev of events) {
    window.addEventListener(ev, onActivity, { passive: true });
  }
  document.addEventListener('visibilitychange', onVisibility);
  armTimer();
};


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Synchronous read. Use this to gate a network call from non-React code. */
export const isIdle = (): boolean => idle;

/** Forced manual resume — for the "tap to reconnect" button. */
export const resumeFromIdle = (): void => {
  if (!idle) return;
  setIdle(false);
  onActivity();
};

/** Subscribe to one-shot resume events (useful for refetching data). */
export const onIdleResume = (fn: () => void): (() => void) => {
  resumeSubs.add(fn);
  return () => { resumeSubs.delete(fn); };
};

/** React hook — returns the current idle state and re-renders on change. */
export const useIdle = (): boolean => {
  const [state, setState] = useState(idle);
  useEffect(() => {
    attachListenersOnce();
    setState(idle);
    subs.add(setState);
    return () => { subs.delete(setState); };
  }, []);
  return state;
};

/** Read the timestamp (ms) of the last user activity. Mostly for diagnostics. */
export const getLastActivityAt = (): number => lastActivity;
