import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Phone, Mail, ArrowRight, AlertCircle, Loader2, CheckCircle2,
  ShieldCheck, Sparkles, MailWarning, ArrowLeft,
} from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { LogoMark } from '../components/Logo';
import { OtpInput } from '../components/OtpInput';
import { HeroPanel, HeroCompact } from '../components/login/HeroPanel';
import {
  lookupAccount, requestOtp, verifyOtp,
  isAuthenticated, isAdmin,
  type LookupResult,
} from '../lib/authClient';
import { useT } from '../lib/i18n';

const friendlyError = (code: string, retryAfter?: number): string => {
  switch (code) {
    case 'invalid_email': return 'Please enter a valid email address.';
    case 'invalid_phone': return 'Please enter a valid phone number.';
    case 'rate_limited':
      return `Too many tries. Please wait ${retryAfter ? Math.ceil(retryAfter / 60) + ' minutes' : 'a while'} before trying again.`;
    case 'invalid_otp': return 'Wrong code. Try again or request a new one.';
    case 'too_many_attempts': return 'Too many wrong tries on this code. Request a new one.';
    case 'user_inactive': return 'This account is inactive. Contact your shop admin.';
    case 'invalid_json':
    case 'invalid_input': return "Couldn't process the request. Try again.";
    default: return 'Something went wrong. Please try again.';
  }
};

// Hardcoded country prefix. The auth-service normalizes by stripping non-digits,
// so this gets concatenated with the user's input and sent as a single phone.
const COUNTRY_PREFIX = '+91';
const COUNTRY_FLAG = '🇮🇳';

type Mode = 'phone' | 'email';
type Step = 'identify' | 'greeting' | 'otp';

// Common spring config — feels snappy + a bit playful, never overshoots too far.
const spring = { type: 'spring' as const, stiffness: 280, damping: 28, mass: 0.8 };

const stepVariants = {
  initial: { opacity: 0, y: 12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring },
  exit:    { opacity: 0, y: -10, scale: 0.98, transition: { duration: 0.18, ease: 'easeIn' as const } },
};

const Login: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as { from?: string } | null)?.from;
  const { t } = useT();

  useEffect(() => {
    if (isAuthenticated()) {
      navigate(redirectTo || (isAdmin() ? '/admin' : '/client'), { replace: true });
    }
  }, [navigate, redirectTo]);

  const [mode, setMode] = useState<Mode>('phone');
  const [step, setStep] = useState<Step>('identify');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [prefix, setPrefix] = useState('');
  const [ttl, setTtl] = useState(10);
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fullPhone = useMemo(() => phone ? `${COUNTRY_PREFIX}${phone}` : '', [phone]);
  const identifier = useMemo(
    () => mode === 'phone' ? fullPhone : email.trim().toLowerCase(),
    [mode, fullPhone, email],
  );

  const handleLookup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const input = mode === 'phone' ? { phone: identifier } : { email: identifier };
      const r = await lookupAccount(input);
      setLookup(r);
      setStep('greeting');
    } catch (err) {
      const e = err as Error & { retryAfter?: number };
      setError(friendlyError(e.message, e.retryAfter));
    } finally {
      setLoading(false);
    }
  };

  const handleSendOtp = async () => {
    setError(null);
    setLoading(true);
    try {
      const input = mode === 'phone' ? { phone: identifier } : { email: identifier };
      const r = await requestOtp(input);
      setPrefix(r.prefix);
      setTtl(r.ttlMinutes);
      setOtp('');
      setStep('otp');
    } catch (err) {
      const e = err as Error & { retryAfter?: number };
      setError(friendlyError(e.message, e.retryAfter));
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (typed?: string) => {
    const secret = (typed || otp).trim();
    if (secret.length < 4) return;
    // The server stores the full code (prefix + secret) under a single hash.
    // The OTP input only collects the 4-char secret half — the prefix is shown
    // as non-editable cells. Re-assemble before sending. Backend normalizes
    // the optional dash, so either format works.
    const fullOtp = `${prefix}${secret}`;
    setError(null);
    setLoading(true);
    try {
      const input = mode === 'phone'
        ? { phone: identifier, otp: fullOtp }
        : { email: identifier, otp: fullOtp };
      const user = await verifyOtp(input);
      // Customers always land on /client (home) — friendliest entry point,
      // and they may have forgotten the original deep link.
      if (user.role === 'client') {
        navigate('/client', { replace: true });
      } else {
        navigate(redirectTo && redirectTo.startsWith('/admin') ? redirectTo : '/admin', { replace: true });
      }
    } catch (err) {
      setError(friendlyError((err as Error).message));
    } finally {
      setLoading(false);
    }
  };

  const goBackToIdentify = () => {
    setStep('identify');
    setOtp('');
    setLookup(null);
    setError(null);
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setStep('identify');
    setLookup(null);
    setOtp('');
    setError(null);
  };

  return (
    <div className="min-h-screen relative overflow-hidden bg-slate-50">
      <AnimatedBackground />

      {/* Desktop: 2-column split. Mobile: single column with compact hero. */}
      <div className="relative z-10 min-h-screen flex flex-col lg:flex-row">

        {/* ─────────── Left panel (desktop only) ─────────── */}
        <div className="hidden lg:flex lg:w-1/2 xl:w-3/5 items-center justify-center">
          <HeroPanel />
        </div>

        {/* ─────────── Right panel (login) ─────────── */}
        <div className="flex-1 flex items-center justify-center px-4 py-10 lg:py-12">
          <motion.div
            className="max-w-md w-full"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...spring, delay: 0.15 }}
          >
            {/* Mobile-only compact hero */}
            <div className="lg:hidden">
              <HeroCompact />
            </div>

            {/* Header (desktop is smaller / inline since left panel carries the brand) */}
            <motion.div
              className="text-center mb-5 lg:mb-6"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ ...spring, delay: 0.2 }}
            >
              <motion.div
                className="inline-flex mb-3 rounded-2xl"
                whileHover={{ scale: 1.05, rotate: -2 }}
                whileTap={{ scale: 0.95 }}
                transition={spring}
                style={{
                  boxShadow:
                    '0 24px 60px -10px rgba(37,99,235,0.4), 0 0 0 1px rgba(37,99,235,0.08)',
                }}
              >
                <LogoMark size={64} className="rounded-2xl" />
              </motion.div>
              <h1 className="text-2xl lg:text-3xl font-bold tracking-tight">
                <span className="bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 bg-clip-text text-transparent">
                  Love
                </span>{' '}
                <span className="text-slate-900">Enterprises</span>
              </h1>
              <motion.p
                key={mode}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-[10px] uppercase tracking-[0.35em] text-blue-600/70 font-semibold mt-1.5"
              >
                {mode === 'phone' ? 'Customer Portal' : 'Admin Console'}
              </motion.p>
            </motion.div>

        {/* Crystal white card */}
        <Card className="relative overflow-hidden bg-white/85 border border-blue-100 backdrop-blur-xl shadow-[0_25px_80px_-20px_rgba(37,99,235,0.35)]">
          {/* Animated gradient strip — blue to white shimmer */}
          <motion.div
            className="absolute inset-x-0 top-0 h-[2px] bg-[linear-gradient(90deg,transparent,#38bdf8_25%,#2563eb_50%,#38bdf8_75%,transparent)] bg-[length:200%_100%]"
            animate={{ backgroundPosition: ['0% 0%', '200% 0%'] }}
            transition={{ duration: 4, ease: 'linear', repeat: Infinity }}
          />

          <CardContent className="p-6 sm:p-7 relative text-slate-900">
            <AnimatePresence mode="wait">
              {step === 'identify' && (
                <motion.form
                  key="identify"
                  variants={stepVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  onSubmit={handleLookup}
                  className="space-y-4"
                >
                  <FieldLabel>{mode === 'phone' ? t('login.phone.label') : t('login.email.label')}</FieldLabel>

                  {mode === 'phone' ? (
                    <>
                      <PhoneInput value={phone} onChange={setPhone} disabled={loading} />
                      <p className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                        {t('login.phoneHelper')}
                      </p>
                    </>
                  ) : (
                    <div className="relative">
                      <Mail className="absolute left-3 top-3 h-5 w-5 text-blue-400" />
                      <Input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        className="pl-10 h-12 bg-white border-blue-200/70 text-slate-900 placeholder:text-slate-400 focus-visible:ring-blue-400/40 focus:border-blue-400 transition"
                        required
                        autoComplete="email"
                        autoFocus
                        disabled={loading}
                        inputMode="email"
                      />
                    </div>
                  )}

                  <AnimatePresence>
                    {error && <ErrorBanner message={error} />}
                  </AnimatePresence>

                  <GradientButton
                    type="submit"
                    loading={loading}
                    disabled={mode === 'phone' ? phone.length < 7 : email.length < 4}
                  >
                    {loading
                      ? <><Loader2 className="h-4 w-4 animate-spin" /> {t('login.checking')}</>
                      : <>{t('login.continue')} <ArrowRight className="h-4 w-4" /></>}
                  </GradientButton>

                  <div className="pt-2 text-center">
                    {mode === 'phone' ? (
                      <ModeSwitchBtn onClick={() => switchMode('email')}>
                        <ShieldCheck className="h-3 w-3" /> {t('login.adminToggle')}
                      </ModeSwitchBtn>
                    ) : (
                      <ModeSwitchBtn onClick={() => switchMode('phone')}>
                        <Phone className="h-3 w-3" /> {t('login.customerToggle')}
                      </ModeSwitchBtn>
                    )}
                  </div>
                </motion.form>
              )}

              {step === 'greeting' && lookup && (
                <motion.div
                  key="greeting"
                  variants={stepVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                >
                  <GreetingStep
                    lookup={lookup}
                    mode={mode}
                    loading={loading}
                    error={error}
                    onSendOtp={handleSendOtp}
                    onBack={goBackToIdentify}
                  />
                </motion.div>
              )}

              {step === 'otp' && (
                <motion.form
                  key="otp"
                  variants={stepVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  onSubmit={e => { e.preventDefault(); handleVerify(); }}
                  className="space-y-4"
                >
                  <motion.div
                    className="bg-sky-50 border border-sky-200 rounded-lg px-3 py-2.5 text-xs text-sky-900 flex items-start gap-2"
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={spring}
                  >
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5 text-sky-600" />
                    <div className="flex-1 min-w-0">
                      {lookup?.name && <p className="font-semibold mb-0.5 text-blue-800">Hi {lookup.name},</p>}
                      <p>
                        Code starting with <strong className="font-mono text-blue-700">{prefix}-</strong> sent to{' '}
                        <strong className="break-all">{lookup?.emailMasked || identifier}</strong>
                      </p>
                      <p className="text-[10px] opacity-70 mt-1">
                        Expires in {ttl} min · Check spam if not received in 30s
                      </p>
                    </div>
                  </motion.div>

                  <FieldLabel>{t('login.otpLabel')}</FieldLabel>
                  <OtpInput
                    prefix={prefix}
                    length={4}
                    value={otp}
                    onChange={setOtp}
                    onComplete={v => { void handleVerify(v); }}
                    autoFocus
                    disabled={loading}
                  />

                  <AnimatePresence>
                    {error && <ErrorBanner message={error} />}
                  </AnimatePresence>

                  <GradientButton type="submit" loading={loading} disabled={otp.length < 4}>
                    {loading
                      ? <><Loader2 className="h-4 w-4 animate-spin" /> {t('login.verifying')}</>
                      : t('login.verify')}
                  </GradientButton>

                  <button
                    type="button"
                    onClick={goBackToIdentify}
                    disabled={loading}
                    className="text-xs text-slate-500 hover:text-blue-700 inline-flex items-center gap-1 mx-auto w-full justify-center transition"
                  >
                    <ArrowLeft className="h-3 w-3" /> Use a different {mode === 'phone' ? 'phone' : 'email'}
                  </button>
                </motion.form>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>

            <motion.p
              className="text-center text-[11px] text-slate-500 mt-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4, duration: 0.5 }}
            >
              {t('login.noAccount')}
            </motion.p>
          </motion.div>
        </div>
      </div>
    </div>
  );
};


// ===========================================================================
// Sub-components
// ===========================================================================

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <label className="block text-[10px] font-semibold text-blue-700/80 uppercase tracking-[0.2em] mb-1.5">
    {children}
  </label>
);

const PhoneInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => (
  <div className="flex items-stretch h-12 rounded-md border border-blue-200/70 bg-white overflow-hidden focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-400/30 transition">
    <div className="flex items-center gap-1.5 px-3 border-r border-blue-100 bg-gradient-to-br from-sky-50 to-blue-50 text-blue-700 font-mono text-sm select-none">
      <span aria-hidden className="text-base">{COUNTRY_FLAG}</span>
      <span className="font-semibold">{COUNTRY_PREFIX}</span>
    </div>
    <input
      type="tel"
      value={value}
      onChange={e => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, 12))}
      placeholder="98765 43210"
      className="flex-1 bg-transparent px-3 text-slate-900 placeholder:text-slate-400 outline-none font-mono tracking-wider"
      autoFocus
      autoComplete="tel-national"
      inputMode="numeric"
      disabled={disabled}
      maxLength={12}
    />
  </div>
);

const GradientButton: React.FC<{
  children: React.ReactNode;
  type?: 'button' | 'submit';
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}> = ({ children, type = 'button', loading, disabled, onClick }) => (
  <motion.button
    type={type}
    onClick={onClick}
    disabled={disabled || loading}
    whileHover={!disabled && !loading ? { scale: 1.02 } : {}}
    whileTap={!disabled && !loading ? { scale: 0.98 } : {}}
    transition={spring}
    className="relative w-full h-12 rounded-md font-semibold text-sm text-white overflow-hidden disabled:opacity-50 disabled:cursor-not-allowed group"
    style={{
      background: 'linear-gradient(90deg, #38bdf8 0%, #2563eb 60%, #1e40af 100%)',
      boxShadow: '0 12px 28px -10px rgba(37,99,235,0.55)',
    }}
  >
    <span
      className="absolute inset-0 bg-[linear-gradient(110deg,transparent_40%,rgba(255,255,255,0.35)_50%,transparent_60%)] bg-[length:200%_100%] opacity-0 group-hover:opacity-100"
      style={{ animation: 'shimmer 1.6s linear infinite' }}
    />
    <span className="relative flex items-center justify-center gap-2">
      {children}
    </span>
    <style>{`@keyframes shimmer { 0% { background-position: 200% 0%; } 100% { background-position: -200% 0%; } }`}</style>
  </motion.button>
);

const ModeSwitchBtn: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <motion.button
    type="button"
    onClick={onClick}
    className="text-[11px] text-slate-500 hover:text-blue-700 inline-flex items-center gap-1.5 transition"
    whileHover={{ x: 2 }}
    transition={spring}
  >
    {children}
  </motion.button>
);

const ErrorBanner: React.FC<{ message: string }> = ({ message }) => (
  <motion.div
    initial={{ opacity: 0, height: 0, scale: 0.95 }}
    animate={{ opacity: 1, height: 'auto', scale: 1 }}
    exit={{ opacity: 0, height: 0, scale: 0.95 }}
    transition={spring}
    className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-xs text-rose-700 flex items-start gap-2"
  >
    <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5 text-rose-500" />
    <span>{message}</span>
  </motion.div>
);

interface GreetingStepProps {
  lookup: LookupResult;
  mode: Mode;
  loading: boolean;
  error: string | null;
  onSendOtp: () => void;
  onBack: () => void;
}

const GreetingStep: React.FC<GreetingStepProps> = ({ lookup, mode, loading, error, onSendOtp, onBack }) => {
  const canSendOtp = lookup.found && lookup.hasEmail;
  return (
    <div className="space-y-4">
      {canSendOtp ? (
        <>
          <div className="text-center py-2">
            <motion.div
              className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-sky-100 to-blue-100 rounded-full mb-3 border border-blue-200"
              initial={{ scale: 0, rotate: -180 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ ...spring, delay: 0.05 }}
            >
              <Sparkles className="h-7 w-7 text-blue-600" />
            </motion.div>
            <motion.h2
              className="text-2xl font-bold text-slate-900"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring, delay: 0.12 }}
            >
              Hello, <span className="bg-gradient-to-r from-sky-500 to-blue-700 bg-clip-text text-transparent">{lookup.name}</span>!
            </motion.h2>
            <motion.p
              className="text-sm text-slate-500 mt-1.5"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.18 }}
            >
              We'll send a one-time code to{' '}
              <strong className="font-mono text-slate-800 break-all">{lookup.emailMasked}</strong>
            </motion.p>
          </div>

          <AnimatePresence>
            {error && <ErrorBanner message={error} />}
          </AnimatePresence>

          <GradientButton onClick={onSendOtp} loading={loading}>
            {loading
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</>
              : <>Send sign-in code <ArrowRight className="h-4 w-4" /></>}
          </GradientButton>
        </>
      ) : (
        <>
          <div className="text-center py-2">
            <motion.div
              className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-amber-100 to-amber-50 rounded-full mb-3 border border-amber-200"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={spring}
            >
              <MailWarning className="h-7 w-7 text-amber-600" />
            </motion.div>
            <h2 className="text-xl font-bold text-slate-900">
              {lookup.found && lookup.name ? `Hi ${lookup.name},` : 'Account setup needed'}
            </h2>
            <p className="text-sm text-slate-500 mt-2 px-2">
              {lookup.found
                ? `We couldn't find a working email on your account.${lookup.adminContact?.shopName ? ` Please contact ${lookup.adminContact.shopName}` : ' Please contact the shop'} to set up email login.`
                : `We couldn't find an account for this ${mode}.${lookup.adminContact?.shopName ? ` Please contact ${lookup.adminContact.shopName}` : ' Please contact the shop'} to register.`}
            </p>
          </div>

          {(lookup.adminContact?.email || lookup.adminContact?.phone) && (
            <motion.div
              className="bg-sky-50 border border-sky-200 rounded-lg p-3 space-y-1.5 text-xs"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring, delay: 0.1 }}
            >
              {lookup.adminContact.email && (
                <div className="flex items-center gap-2">
                  <Mail className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                  <a href={`mailto:${lookup.adminContact.email}`} className="text-blue-700 hover:text-blue-900 hover:underline break-all font-semibold">
                    {lookup.adminContact.email}
                  </a>
                </div>
              )}
              {lookup.adminContact.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                  <a href={`tel:${lookup.adminContact.phone}`} className="text-blue-700 hover:text-blue-900 hover:underline font-semibold">
                    {lookup.adminContact.phone}
                  </a>
                </div>
              )}
            </motion.div>
          )}

          {!lookup.adminContact?.email && !lookup.adminContact?.phone && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-[11px] text-slate-500 text-center italic">
              Contact details will appear once the shop admin configures them.
            </div>
          )}
        </>
      )}

      <button
        type="button"
        onClick={onBack}
        disabled={loading}
        className="text-xs text-slate-500 hover:text-blue-700 inline-flex items-center gap-1 mx-auto w-full justify-center transition"
      >
        <ArrowLeft className="h-3 w-3" /> Use a different {mode === 'phone' ? 'phone' : 'email'}
      </button>
    </div>
  );
};


/**
 * Animated multi-layer background — light & airy blue→white palette.
 * Soft drifting blue blobs over a near-white base, plus a subtle radial glow.
 */
const AnimatedBackground: React.FC = () => (
  <>
    {/* Light gradient base: white at top, sky-blue tint at bottom */}
    <div className="absolute inset-0 bg-gradient-to-br from-white via-sky-50 to-blue-100" />

    {/* Soft radial spotlight behind the card */}
    <motion.div
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] rounded-full pointer-events-none"
      style={{
        background: 'radial-gradient(closest-side, rgba(59,130,246,0.18), rgba(59,130,246,0) 70%)',
      }}
      animate={{ scale: [1, 1.08, 1] }}
      transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
    />

    {/* Drifting blue blobs in varying tones */}
    <motion.div
      className="absolute top-0 left-0 w-[28rem] h-[28rem] rounded-full blur-3xl"
      style={{ background: 'radial-gradient(circle, rgba(56,189,248,0.55), transparent 60%)' }}
      animate={{
        x: ['-30%', '15%', '-30%'],
        y: ['-30%', '10%', '-30%'],
      }}
      transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }}
    />
    <motion.div
      className="absolute bottom-0 right-0 w-[30rem] h-[30rem] rounded-full blur-3xl"
      style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.4), transparent 60%)' }}
      animate={{
        x: ['20%', '-10%', '20%'],
        y: ['20%', '-5%', '20%'],
      }}
      transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }}
    />
    <motion.div
      className="absolute top-1/3 right-1/4 w-72 h-72 rounded-full blur-3xl"
      style={{ background: 'radial-gradient(circle, rgba(165,180,252,0.45), transparent 60%)' }}
      animate={{
        x: ['0%', '15%', '0%'],
        y: ['0%', '8%', '0%'],
      }}
      transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
    />

    {/* Subtle dot grid overlay — very low opacity, lends a tech-y precision */}
    <div
      className="absolute inset-0 opacity-[0.4] pointer-events-none"
      style={{
        backgroundImage:
          'radial-gradient(circle, rgba(37,99,235,0.12) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
        maskImage: 'radial-gradient(ellipse at center, black, transparent 70%)',
        WebkitMaskImage: 'radial-gradient(ellipse at center, black, transparent 70%)',
      }}
    />
  </>
);

export default Login;
