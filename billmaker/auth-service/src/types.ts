// Shared type definitions across the Worker.

/** Cloudflare Worker bindings (env vars + secrets). Mirrors keys in .env. */
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;

  // Provider switch: 'brevo' or 'resend'. Both supported in lib/email.ts.
  EMAIL_PROVIDER?: string;

  // Brevo (recommended free tier — 300/day, no domain needed)
  BREVO_API_KEY?: string;

  // Resend (alternative — 100/day, domain verification required for arbitrary recipients)
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RESEND_FROM_NAME?: string;

  // Shared "from" address fields — used by whichever provider is active
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;

  JWT_SECRET: string;
  /** Supabase project JWT secret — used to mint Realtime/PostgREST tokens
   *  for the Baniya mobile app (which has no user-level auth). Find at
   *  Supabase Dashboard → Settings → API → JWT Secret. Different from
   *  SUPABASE_SERVICE_KEY (which is a long-lived service role token). */
  SUPABASE_JWT_SECRET?: string;
  /** Supabase project ANON key — publishable. Mobile needs it to initialize
   *  the supabase-js client before swapping auth to the minted realtime JWT.
   *  Find at Supabase Dashboard → Settings → API → anon public. */
  SUPABASE_ANON_KEY?: string;
  OTP_PEPPER: string;
  BOOTSTRAP_SECRET: string;
  ADMIN_EMAIL: string;
  ADMIN_NAME: string;
  SHOP_CODE: string;
  /** Human-readable shop display name — shown in OTP emails and admin alerts.
   *  Falls back to a generic label if unset. Set in .env / wrangler [vars]. */
  SHOP_NAME?: string;
  /** Base URL of the deployed web-portal (e.g. https://portal.yourshop.example).
   *  Used to build the "View logs" link in worker alert emails. Optional. */
  PORTAL_URL?: string;
  // "primary" (3 crons) or "secondary" (1 cron with rotation).
  // Controls scheduled handler dispatch. Defaults to "primary" if absent.
  WORKER_PROFILE?: 'primary' | 'secondary';
  ALLOWED_ORIGINS: string;
  RATE_LIMIT_PER_IDENTIFIER_PER_HOUR?: string;
  RATE_LIMIT_PER_IP_PER_HOUR?: string;
  RATE_LIMIT_VERIFY_ATTEMPTS?: string;
  /** Cap on /auth/verify-otp calls per IP per hour. Defaults to 60. */
  RATE_LIMIT_VERIFY_PER_IP_PER_HOUR?: string;

  /** Cloudflare Workers Rate Limiting binding for /auth/verify-otp.
   *  Configured in wrangler.toml. 5 req / 60s per IP. Edge-cached, fast. */
  VERIFY_OTP_LIMITER?: {
    limit(opts: { key: string }): Promise<{ success: boolean }>;
  };

  /** Cloudflare Workers Rate Limiting binding for /auth/lookup.
   *  Configured in wrangler.toml. 10 req / 60s per IP. */
  LOOKUP_LIMITER?: {
    limit(opts: { key: string }): Promise<{ success: boolean }>;
  };
  OTP_TTL_MINUTES?: string;
  /** Admin session JWT TTL in minutes. Default 720 (12h). */
  JWT_TTL_MINUTES?: string;
  /** Client session JWT TTL in minutes. Default 43200 (30 days). Separate so
   *  the customer-facing portal can stay "logged in" for non-tech users while
   *  admins keep a tighter window. */
  JWT_TTL_CLIENT_MINUTES?: string;

  // Firebase service account — used by the cron sync job to read Firestore.
  // See .env section 9 for how to obtain these. The PRIVATE_KEY field carries
  // literal `\n` escapes which we re-expand to real newlines before signing.
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;

  // Optional — Cloudflare Workers usage stats (Analytics GraphQL API).
  // Create token at dash.cloudflare.com/profile/api-tokens with scope:
  //   Account → Analytics → Read
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ANALYTICS_TOKEN?: string;

  // Optional — Cloudinary usage stats (Admin API).
  // All three from cloudinary.com → Console → Account Details.
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
}

export interface AuthedUser {
  id: string;
  identifier: string;
  name: string;
  role: 'client' | 'admin';
  shop_code: string;
  customer_id: string | null;
  class: string | null;
  active: boolean;
}

export interface SessionClaims {
  sub: string;        // user.id
  jti: string;        // session.token_jti
  role: 'client' | 'admin';
  shop: string;       // shop_code
  cust: string | null;
  cls: string | null;
  exp: number;
  iat: number;
}

export type Variables = {
  user: AuthedUser;
  claims: SessionClaims;
};
