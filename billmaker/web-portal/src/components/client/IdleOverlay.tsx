// IdleOverlay
//
// Renders a full-screen modal-like overlay when the user is idle (see lib/idle.ts).
// The overlay blocks interaction with the underlying page until the user clicks
// "Tap to reconnect" or interacts with anything else (the idle module's event
// listeners will auto-resume on the next mouse/key/touch event).
//
// Only mounted inside the client-side Layout. Admin pages don't get this — admin
// is actively working with mutations, so pausing isn't a clear win.

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useIdle, resumeFromIdle } from '../../lib/idle';
import { currentUser } from '../../lib/authClient';
import { useT } from '../../lib/i18n';

export const IdleOverlay: React.FC = () => {
  const idle = useIdle();
  // Only relevant for client users — admin keeps Firestore listeners running anyway.
  const isClient = currentUser()?.role === 'client';
  const { t } = useT();

  return (
    <AnimatePresence>
      {idle && isClient && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center px-4 backdrop-blur-md bg-slate-900/40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          onClick={resumeFromIdle}
        >
          <motion.div
            className="relative max-w-sm w-full bg-white rounded-2xl border border-blue-100 shadow-2xl shadow-blue-500/20 overflow-hidden"
            initial={{ scale: 0.92, y: 12, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.95, y: 8, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="h-[2px] bg-gradient-to-r from-sky-400 via-blue-600 to-indigo-600" />
            <div className="p-6 text-center">
              <motion.div
                className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-sky-100 to-blue-100 border border-blue-200 mb-4"
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
              >
                <CloudOff className="h-7 w-7 text-blue-600" />
              </motion.div>
              <h2 className="text-lg font-bold text-slate-900">{t('idle.awayTitle')}</h2>
              <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                {t('idle.awayBody')}
              </p>
              <button
                onClick={resumeFromIdle}
                className="mt-5 w-full h-11 rounded-md font-semibold text-sm text-white inline-flex items-center justify-center gap-2"
                style={{
                  background: 'linear-gradient(90deg, #38bdf8 0%, #2563eb 60%, #1e40af 100%)',
                  boxShadow: '0 10px 24px -10px rgba(37,99,235,0.55)',
                }}
              >
                <RefreshCw className="h-4 w-4" />
                {t('idle.reconnect')}
              </button>
              <p className="text-[10px] text-slate-400 mt-3">
                {t('idle.tapDismiss')}
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
