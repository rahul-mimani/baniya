import React, { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './routes/Login';
import AdminHome from './routes/AdminHome';
import AdminBills from './routes/AdminBills';
import AdminCustomers from './routes/AdminCustomers';
import AdminManageCustomers from './routes/AdminManageCustomers';
import AdminProducts from './routes/AdminProducts';
import AdminLabels from './routes/AdminLabels';
import AdminDeals from './routes/AdminDeals';
import AdminSettings from './routes/AdminSettings';
import AdminLogs from './routes/AdminLogs';
import AdminOutstanding from './routes/AdminOutstanding';
import AdminUsers from './routes/AdminUsers';
import AdminQuotes from './routes/AdminQuotes';
import AdminReprints from './routes/AdminReprints';
import AdminUsage from './routes/AdminUsage';
import AdminStatements from './routes/AdminStatements';
import { AuthGate } from './components/AuthGate';
import ClientHome from './routes/ClientHome';
import ClientBills from './routes/ClientBills';
import ClientDeals from './routes/ClientDeals';
import ClientQuotes from './routes/ClientQuotes';
import ClientTier from './routes/ClientTier';
import { installGlobalErrorHandlers, log } from './lib/logger';
import { initSync, teardown as teardownSync } from './lib/firestoreSync';
import { getPortalConfig, onConfigChange } from './data/portalConfig';
import { currentUser, onAuthChange } from './lib/authClient';

let handlersInstalled = false;

const App: React.FC = () => {
  useEffect(() => {
    if (!handlersInstalled) {
      installGlobalErrorHandlers();
      handlersInstalled = true;
      log('info', 'general', 'Portal app booted');
    }
    // Firestore is admin-only. Clients read from the auth-service replica
    // (see lib/clientData.ts). Initialize/tear down Firestore based on the
    // current authed user's role + any config changes.
    const applyByRole = () => {
      const user = currentUser();
      if (user?.role === 'admin') {
        initSync(getPortalConfig());
      } else {
        // Either logged out or logged in as client — clients must not see Firestore.
        log('info', 'sync', 'Firestore sync disabled (non-admin user)');
        void teardownSync();
      }
    };

    applyByRole();
    const offConfig = onConfigChange(cfg => {
      if (currentUser()?.role === 'admin') {
        log('info', 'config', 'Config changed — re-initializing Firestore sync');
        initSync(cfg);
      }
    });
    const offAuth = onAuthChange(applyByRole);
    return () => { offConfig(); offAuth(); };
  }, []);

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<Login />} />

      <Route element={<AuthGate><Layout /></AuthGate>}>
        {/* Admin-only routes: gated by AuthGate's requireAdmin */}
        <Route path="/admin" element={<AuthGate requireAdmin><AdminHome /></AuthGate>} />
        <Route path="/admin/bills" element={<AuthGate requireAdmin><AdminBills /></AuthGate>} />
        <Route path="/admin/customers" element={<AuthGate requireAdmin><AdminCustomers /></AuthGate>} />
        <Route path="/admin/manage-customers" element={<AuthGate requireAdmin><AdminManageCustomers /></AuthGate>} />
        <Route path="/admin/products" element={<AuthGate requireAdmin><AdminProducts /></AuthGate>} />
        <Route path="/admin/labels" element={<AuthGate requireAdmin><AdminLabels /></AuthGate>} />
        <Route path="/admin/deals" element={<AuthGate requireAdmin><AdminDeals /></AuthGate>} />
        <Route path="/admin/outstanding" element={<AuthGate requireAdmin><AdminOutstanding /></AuthGate>} />
        <Route path="/admin/users" element={<AuthGate requireAdmin><AdminUsers /></AuthGate>} />
        <Route path="/admin/quotes" element={<AuthGate requireAdmin><AdminQuotes /></AuthGate>} />
        <Route path="/admin/reprints" element={<AuthGate requireAdmin><AdminReprints /></AuthGate>} />
        <Route path="/admin/usage" element={<AuthGate requireAdmin><AdminUsage /></AuthGate>} />
        <Route path="/admin/statements" element={<AuthGate requireAdmin><AdminStatements /></AuthGate>} />
        <Route path="/admin/settings" element={<AuthGate requireAdmin><AdminSettings /></AuthGate>} />
        <Route path="/admin/logs" element={<AuthGate requireAdmin><AdminLogs /></AuthGate>} />

        {/* Client-only routes — admins get bounced to /admin. */}
        <Route path="/client" element={<AuthGate requireClient><ClientHome /></AuthGate>} />
        <Route path="/client/bills" element={<AuthGate requireClient><ClientBills /></AuthGate>} />
        <Route path="/client/deals" element={<AuthGate requireClient><ClientDeals /></AuthGate>} />
        <Route path="/client/quotes" element={<AuthGate requireClient><ClientQuotes /></AuthGate>} />
        <Route path="/client/tier" element={<AuthGate requireClient><ClientTier /></AuthGate>} />
      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
};

export default App;
