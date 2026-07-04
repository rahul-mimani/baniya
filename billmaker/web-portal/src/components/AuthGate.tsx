import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getAuthState, onAuthChange, isAuthenticated, validateSession } from '../lib/authClient';

interface Props {
  children: React.ReactNode;
  /** Only role==='admin' may pass. Clients get redirected to /client. */
  requireAdmin?: boolean;
  /** Only role==='client' may pass. Admins get redirected to /admin. */
  requireClient?: boolean;
}

export const AuthGate: React.FC<Props> = ({ children, requireAdmin = false, requireClient = false }) => {
  const [auth, setAuth] = useState(getAuthState());
  const location = useLocation();

  useEffect(() => onAuthChange(setAuth), []);

  useEffect(() => {
    if (isAuthenticated()) {
      validateSession();
    }
  }, []);

  // Not logged in → bounce to /login (preserve where they were going)
  if (!auth.token || !auth.user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  // Strict role separation — each role only sees its own routes. No "view as"
  // crossover from URL bar.
  if (requireAdmin && auth.user.role !== 'admin') {
    return <Navigate to="/client" replace />;
  }
  if (requireClient && auth.user.role !== 'client') {
    return <Navigate to="/admin" replace />;
  }

  return <>{children}</>;
};
