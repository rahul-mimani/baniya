import React, { useEffect, useState } from 'react';
import { Link, useLocation, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Receipt,
  Users,
  Package,
  Sparkles,
  Menu,
  Link2,
  Tag,
  Settings as SettingsIcon,
  ScrollText,
  IndianRupee,
  KeyRound,
  MessageSquare,
  RefreshCw,
  Activity,
  Crown,
  LogOut,
  Mail,
} from 'lucide-react';
import { currentUser, logout, onAuthChange } from '../lib/authClient';
import { getPortalConfig, isConfigValid, onConfigChange } from '../data/portalConfig';
import { useT, setLang, LANGS } from '../lib/i18n';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from './ui/sheet';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { LogoMark, LogoWordmark } from './Logo';
import { IdleOverlay } from './client/IdleOverlay';
import { cn } from '../lib/utils';

const navAdmin = [
  { path: '/admin', label: 'Overview', icon: LayoutDashboard },
  { path: '/admin/bills', label: 'Bills', icon: Receipt },
  { path: '/admin/customers', label: 'Customers', icon: Users },
  { path: '/admin/manage-customers', label: 'Manage Customers', icon: Link2 },
  { path: '/admin/products', label: 'Products', icon: Package },
  { path: '/admin/labels', label: 'Labels & Classes', icon: Tag },
  { path: '/admin/deals', label: 'Deals', icon: Sparkles },
  { path: '/admin/outstanding', label: 'Settle Outstanding', icon: IndianRupee },
  { path: '/admin/statements', label: 'Statements', icon: Mail },
  { path: '/admin/quotes', label: 'Quote requests', icon: MessageSquare },
  { path: '/admin/reprints', label: 'Reprint requests', icon: RefreshCw },
  { path: '/admin/users', label: 'Client logins', icon: KeyRound },
  { path: '/admin/usage', label: 'Usage', icon: Activity },
  { path: '/admin/settings', label: 'Settings', icon: SettingsIcon },
  { path: '/admin/logs', label: 'Logs', icon: ScrollText },
];

// Client nav items use translation keys, resolved at render time.
const navClient = [
  { path: '/client',         labelKey: 'nav.home',   icon: LayoutDashboard },
  { path: '/client/bills',   labelKey: 'nav.bills',  icon: Receipt },
  { path: '/client/deals',   labelKey: 'nav.deals',  icon: Sparkles },
  { path: '/client/tier',    labelKey: 'nav.tier',   icon: Crown },
  { path: '/client/quotes',  labelKey: 'nav.quotes', icon: MessageSquare },
];

const Layout: React.FC = () => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [config, setConfig] = useState(getPortalConfig());
  const [authedUser, setAuthedUser] = useState(currentUser());
  const { t, lang } = useT();
  const loc = useLocation();
  const navigate = useNavigate();

  useEffect(() => onConfigChange(setConfig), []);
  useEffect(() => onAuthChange(s => setAuthedUser(s.user)), []);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  // Close drawer on route change
  useEffect(() => { setMobileOpen(false); }, [loc.pathname]);

  // View follows the authenticated user's role. No URL or toggle override —
  // admin/client are strictly separated by AuthGate (see App.tsx).
  const role: 'admin' | 'client' = authedUser?.role === 'admin' ? 'admin' : 'client';
  const items = role === 'admin' ? navAdmin : navClient;
  const firestoreConnected = role === 'admin' && isConfigValid(config);

  const sidebarContent = (
    <div className="flex h-full flex-col">
      <div className="px-5 py-5 border-b">
        <div className="flex items-center gap-3">
          <LogoMark size={40} className="shadow-lg shadow-primary/30 rounded-xl" />
          <div>
            <LogoWordmark className="font-bold leading-none text-lg" />
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mt-1">
              {role === 'admin' ? 'Admin Console' : 'My Account'}
            </p>
          </div>
        </div>
      </div>

      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {items.map(item => {
          const Icon = item.icon;
          const active =
            loc.pathname === item.path ||
            (item.path !== '/admin' && item.path !== '/client' && loc.pathname.startsWith(item.path));
          // Client nav uses translation keys; admin nav uses static labels.
          const label = 'labelKey' in item ? t(item.labelKey) : (item as any).label;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-semibold transition',
                active
                  ? 'bg-gradient-to-r from-primary/10 to-secondary/10 text-primary border border-primary/20 shadow-sm'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className={cn('h-4 w-4', active ? 'text-primary' : 'text-muted-foreground')} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="px-5 py-4 border-t bg-muted/30">
        <div className="flex items-center gap-2">
          <div className={cn(
            'w-8 h-8 rounded-full text-white text-xs font-bold flex items-center justify-center',
            role === 'admin'
              ? 'bg-gradient-to-br from-primary to-accent'
              : 'bg-gradient-to-br from-secondary to-accent',
          )}>
            {(authedUser?.name || (role === 'admin' ? 'A' : 'C')).slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-foreground truncate">{authedUser?.name || (role === 'admin' ? 'Admin' : 'Client')}</p>
            <p className="text-[10px] text-muted-foreground truncate">{authedUser?.identifier || ''}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            title="Sign out"
            className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-rose-600 transition"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
        {role === 'admin' && (
          <div className="mt-2 flex items-center gap-1.5 text-[10px]">
            <span className={cn('w-1.5 h-1.5 rounded-full', firestoreConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400')} />
            <span className={firestoreConnected ? 'text-emerald-700 font-semibold' : 'text-muted-foreground'}>
              {firestoreConnected ? `Firestore: ${config.projectId}` : 'Firestore not configured'}
            </span>
          </div>
        )}

        {/* Language switcher — client side only. Compact two-button toggle. */}
        {role === 'client' && (
          <div className="mt-3 flex gap-1 bg-white rounded-md p-0.5 border border-slate-200">
            {LANGS.map(l => (
              <button
                key={l.code}
                onClick={() => setLang(l.code)}
                className={cn(
                  'flex-1 text-[10px] font-bold uppercase tracking-wider py-1 rounded transition',
                  lang === l.code
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-slate-500 hover:text-slate-900',
                )}
              >
                {l.localLabel}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-72 bg-card border-r flex-col fixed inset-y-0 left-0">
        {sidebarContent}
      </aside>

      {/* Mobile top bar with hamburger */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-30 bg-card/95 backdrop-blur border-b">
        <div className="px-3 py-2.5 flex items-center justify-between">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-72">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              {sidebarContent}
            </SheetContent>
          </Sheet>

          <div className="flex items-center gap-2">
            <LogoMark size={32} className="shadow rounded-lg" />
            <p className="font-bold text-foreground text-sm">
              <span className="bg-gradient-to-r from-sky-500 via-primary to-accent bg-clip-text text-transparent">Love</span>{' '}
              Enterprises
              {role === 'admin' && (
                <> · <span className="text-muted-foreground font-medium">Admin</span></>
              )}
            </p>
          </div>

          {role === 'admin' && <Badge variant="default">ADMIN</Badge>}
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto lg:ml-72 pt-14 lg:pt-0">
        <Outlet />
      </main>

      {/* Idle overlay — only fires for client role, sleeps after 10 min inactivity */}
      <IdleOverlay />
    </div>
  );
};

export default Layout;
