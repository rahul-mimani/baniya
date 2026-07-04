// Lightweight i18n for client-facing pages.
//
// Why custom and not react-i18next:
//   - We have ~80 strings across the client UI. A full library would be
//     overkill (and ~30KB extra bundle) for that.
//   - Switching language only affects the client view. Admin stays English.
//   - We persist the choice in localStorage so it survives reloads.

import { useEffect, useState } from 'react';

export type Lang = 'en' | 'hi';
export const LANGS: { code: Lang; label: string; localLabel: string }[] = [
  { code: 'en', label: 'English', localLabel: 'English' },
  { code: 'hi', label: 'Hindi',   localLabel: 'हिन्दी' },
];

const STORAGE_KEY = 'billmaker-portal-lang-v1';

// Translation dictionary. Keys are stable English short codes. Values are
// objects keyed by language. Missing translations fall back to English.
//
// Naming convention:  area.subarea.specific   (lowercase, dot-separated)
type Dict = Record<string, Record<Lang, string>>;

const dict: Dict = {
  // -------- Nav (sidebar items shown to client) --------
  'nav.home':    { en: 'Home',           hi: 'होम' },
  'nav.bills':   { en: 'My Bills',       hi: 'मेरे बिल' },
  'nav.deals':   { en: 'Deals & Offers', hi: 'डील्स और ऑफ़र्स' },
  'nav.tier':    { en: 'My Tier',        hi: 'मेरा स्तर' },
  'nav.quotes':  { en: 'My Quotes',      hi: 'मेरे कोट्स' },

  // -------- Common UI --------
  'common.loading':       { en: 'Loading…',       hi: 'लोड हो रहा है…' },
  'common.cancel':        { en: 'Cancel',         hi: 'रद्द करें' },
  'common.close':         { en: 'Close',          hi: 'बंद करें' },
  'common.save':          { en: 'Save',           hi: 'सहेजें' },
  'common.send':          { en: 'Send',           hi: 'भेजें' },
  'common.refresh':       { en: 'Refresh',        hi: 'रिफ्रेश' },
  'common.search':        { en: 'Search',         hi: 'खोजें' },
  'common.clear':         { en: 'Clear',          hi: 'साफ़ करें' },
  'common.tryAgain':      { en: 'Try again',      hi: 'फिर से कोशिश करें' },
  'common.contactAdmin':  { en: 'Contact admin',  hi: 'एडमिन से संपर्क करें' },
  'common.welcomeBack':   { en: 'Welcome back',   hi: 'फिर से स्वागत है' },
  'common.signOut':       { en: 'Sign out',       hi: 'साइन आउट' },
  'common.viewAll':       { en: 'View all',       hi: 'सभी देखें' },
  'common.loadMore':      { en: 'Load more',      hi: 'और दिखाएं' },

  // -------- Login --------
  'login.phone.label':    { en: 'Phone number',           hi: 'फोन नंबर' },
  'login.email.label':    { en: 'Email address',          hi: 'ईमेल पता' },
  'login.continue':       { en: 'Continue',               hi: 'जारी रखें' },
  'login.checking':       { en: 'Checking…',              hi: 'जांच रहे हैं…' },
  'login.sendCode':       { en: 'Send sign-in code',      hi: 'साइन-इन कोड भेजें' },
  'login.sending':        { en: 'Sending…',               hi: 'भेज रहे हैं…' },
  'login.verify':         { en: 'Sign in',                hi: 'साइन इन' },
  'login.verifying':      { en: 'Verifying…',             hi: 'सत्यापित हो रहा है…' },
  'login.otpLabel':       { en: 'Enter the 4-character code', hi: '4-अक्षर कोड दर्ज करें' },
  'login.phoneHelper':    {
    en: "Use the same number your admin has on file. We'll send a one-time code to the email linked to your account.",
    hi: 'वही नंबर डालें जो एडमिन के पास दर्ज है। आपके अकाउंट से जुड़े ईमेल पर एक-बार वाला कोड भेजा जाएगा।',
  },
  'login.adminToggle':    { en: 'Shop admin? Sign in with email', hi: 'एडमिन हैं? ईमेल से साइन इन करें' },
  'login.customerToggle': { en: 'Customer? Sign in with phone',   hi: 'ग्राहक हैं? फोन से साइन इन करें' },
  'login.noAccount':      { en: "Don't have an account? Contact admin to add your details.", hi: 'अकाउंट नहीं है? अपनी जानकारी जोड़ने के लिए एडमिन से संपर्क करें।' },
  'login.helloName':      { en: 'Hello',                  hi: 'नमस्ते' },
  'login.codeSentTo':     { en: "We'll send a one-time code to", hi: 'आपके इस पते पर एक-बार वाला कोड भेजेंगे:' },
  'login.useDifferent':   { en: 'Use a different',        hi: 'अलग का उपयोग करें' },
  'login.backToProduct':  { en: 'Back',                   hi: 'वापस' },

  // -------- Bills --------
  'bills.title':              { en: 'My Bills',                   hi: 'मेरे बिल' },
  'bills.subtitle':           { en: 'bills on your account',      hi: 'बिल आपके खाते पर' },
  'bills.subtitleOne':        { en: 'bill on your account',       hi: 'बिल आपके खाते पर' },
  'bills.empty.title':        { en: 'No bills yet',               hi: 'अभी कोई बिल नहीं' },
  'bills.empty.subtitle':     { en: "When new bills are released to you, they'll appear here.", hi: 'जब आपके लिए नए बिल जारी होंगे, वे यहाँ दिखेंगे।' },
  'bills.noMatch':            { en: 'No bills match',             hi: 'कोई बिल मेल नहीं खाता' },
  'bills.totalBilled':        { en: 'Total billed',               hi: 'कुल बिल' },
  'bills.totalPaid':          { en: 'Total paid',                 hi: 'कुल भुगतान' },
  'bills.outstanding':        { en: 'Outstanding',                hi: 'बकाया' },
  'bills.due':                { en: 'due',                        hi: 'बकाया' },
  'bills.paid':               { en: 'Paid',                       hi: 'भुगतान हुआ' },
  'bills.partial':            { en: 'Partial',                    hi: 'आंशिक' },
  'bills.unpaid':             { en: 'Unpaid',                     hi: 'भुगतान बाकी' },
  'bills.subtotal':           { en: 'Subtotal',                   hi: 'उप-योग' },
  'bills.balance':            { en: 'Balance',                    hi: 'शेष' },
  'bills.item':               { en: 'Item',                       hi: 'वस्तु' },
  'bills.qty':                { en: 'Qty',                        hi: 'मात्रा' },
  'bills.rate':               { en: 'Rate',                       hi: 'दर' },
  'bills.amount':             { en: 'Amount',                     hi: 'राशि' },
  'bills.downloadPdf':        { en: 'Download PDF',               hi: 'PDF डाउनलोड' },
  'bills.generating':         { en: 'Generating…',                hi: 'बना रहे हैं…' },
  'bills.shareWhatsapp':      { en: 'Share on WhatsApp',          hi: 'WhatsApp पर भेजें' },
  'bills.sharing':            { en: 'Sharing…',                   hi: 'भेज रहे हैं…' },
  'bills.requestReprint':     { en: 'Request reprint',            hi: 'पुनः प्रिंट की मांग' },
  'bills.requesting':         { en: 'Requesting…',                hi: 'अनुरोध भेज रहे हैं…' },
  'bills.reprintRequested':   { en: 'Reprint requested',          hi: 'पुनः प्रिंट का अनुरोध भेजा गया' },
  'bills.search':             { en: 'Search bill number or product…', hi: 'बिल नंबर या प्रोडक्ट खोजें…' },
  'bills.sort.dateDesc':      { en: 'Newest first',               hi: 'नवीनतम पहले' },
  'bills.sort.dateAsc':       { en: 'Oldest first',               hi: 'सबसे पुराने पहले' },
  'bills.sort.amountDesc':    { en: 'Highest amount',             hi: 'सबसे ज्यादा राशि' },
  'bills.sort.amountAsc':     { en: 'Lowest amount',              hi: 'सबसे कम राशि' },
  'bills.sort.dueDesc':       { en: 'Most outstanding',           hi: 'सबसे ज्यादा बकाया' },

  // -------- Home --------
  'home.welcome':             { en: 'Welcome back',               hi: 'फिर से स्वागत है' },
  'home.myBills':             { en: 'My bills',                   hi: 'मेरे बिल' },
  'home.totalPurchased':      { en: 'Total purchased',            hi: 'कुल खरीद' },
  'home.outstanding':         { en: 'Outstanding',                hi: 'बकाया' },
  'home.recentBills':         { en: 'Recent bills',               hi: 'हाल के बिल' },
  'home.releasedToYou':       { en: 'Released to you',            hi: 'आपके लिए जारी' },
  'home.dealsForYou':         { en: 'Deals for you',              hi: 'आपके लिए डील्स' },
  'home.handpicked':          { en: 'Hand-picked for you',        hi: 'आपके लिए चुनी गई' },
  'home.noBillsYet':          { en: 'No bills released yet.',     hi: 'अभी कोई बिल जारी नहीं।' },
  'home.outstandingAlert':    { en: 'Outstanding balance',        hi: 'बकाया राशि' },
  'home.outstandingDetail':   { en: 'across your bills',          hi: 'सभी बिलों में' },
  'home.notLinked':           { en: 'No customer profile is linked to this login yet. Please contact admin to link it.', hi: 'इस लॉगिन से कोई ग्राहक प्रोफ़ाइल अभी तक जुड़ी नहीं है। कृपया एडमिन से संपर्क करें।' },

  // -------- Deals --------
  'deals.title':              { en: 'Deals & Products',           hi: 'डील्स और प्रोडक्ट्स' },
  'deals.pricesFor':          { en: 'Prices below are for',       hi: 'नीचे की कीमतें इनके लिए हैं:' },
  'deals.yourTier':           { en: 'your tier',                  hi: 'आपका स्तर' },
  'deals.active':             { en: 'Active deals',               hi: 'सक्रिय डील्स' },
  'deals.available':          { en: 'Available products',         hi: 'उपलब्ध प्रोडक्ट्स' },
  'deals.noProducts':         { en: 'No products available for your tier yet.', hi: 'आपके स्तर के लिए अभी कोई प्रोडक्ट उपलब्ध नहीं।' },
  'deals.viewDetails':        { en: 'View details',               hi: 'विवरण देखें' },
  'deals.details':            { en: 'Details',                    hi: 'विवरण' },
  'deals.requestQuote':       { en: 'Request a quote',            hi: 'कोट का अनुरोध' },
  'deals.quote':              { en: 'Quote',                      hi: 'कोट' },
  'deals.inStock':            { en: 'In stock',                   hi: 'स्टॉक में' },
  'deals.outOfStock':         { en: 'Out of stock',               hi: 'स्टॉक में नहीं' },
  'deals.yourPrice':          { en: 'Your price',                 hi: 'आपकी कीमत' },

  // -------- Quotes --------
  'quotes.title':             { en: 'My Quotes',                  hi: 'मेरे कोट्स' },
  'quotes.empty.title':       { en: 'No quotes yet',              hi: 'अभी कोई कोट नहीं' },
  'quotes.empty.subtitle':    { en: 'Open a product and tap "Request a quote" to ask for a price.', hi: 'किसी प्रोडक्ट को खोलें और "कोट का अनुरोध" पर टैप करके कीमत मांगें।' },
  'quotes.pending':           { en: 'Pending',                    hi: 'लंबित' },
  'quotes.accepted':          { en: 'Accepted',                   hi: 'स्वीकृत' },
  'quotes.rejected':          { en: 'Declined',                   hi: 'अस्वीकृत' },
  'quotes.fulfilled':         { en: 'Fulfilled',                  hi: 'पूरा हुआ' },
  'quotes.shopReply':         { en: "Reply",                      hi: 'जवाब' },
  'quotes.waiting':           { en: 'Waiting for a response…',    hi: 'जवाब का इंतज़ार…' },

  // -------- Tier --------
  'tier.your':                { en: 'Your tier',                  hi: 'आपका स्तर' },
  'tier.allTiers':            { en: 'All tiers',                  hi: 'सभी स्तर' },
  'tier.youAreHere':          { en: 'You are here',               hi: 'आप यहां हैं' },
  'tier.locked':              { en: 'Locked',                     hi: 'बंद' },
  'tier.cleared':             { en: 'Cleared',                    hi: 'पार किया' },
  'tier.unlock':              { en: 'Unlock',                     hi: 'अनलॉक' },
  'tier.rank':                { en: 'Rank',                       hi: 'स्तर' },
  'tier.of':                  { en: 'of',                         hi: 'का' },
  'tier.tiersAbove':          { en: 'tiers above you',            hi: 'आपसे ऊपर स्तर' },
  'tier.oneTierAbove':        { en: '1 tier above you',           hi: '1 स्तर आपसे ऊपर' },
  'tier.help.title':          { en: 'Curious about your tier?',   hi: 'अपने स्तर के बारे में जानना है?' },
  'tier.help.body':           { en: 'Tiers are set by admin based on your purchase history and relationship. Reach out to admin anytime to discuss a change.', hi: 'स्तर एडमिन द्वारा आपकी खरीद के आधार पर तय किए जाते हैं। बदलाव के लिए कभी भी एडमिन से संपर्क करें।' },

  // -------- Idle / network --------
  'idle.awayTitle':           { en: "You've been away",           hi: 'आप कुछ देर के लिए दूर थे' },
  'idle.awayBody':            { en: 'We paused updates to save your battery and our servers. Tap below to reconnect.', hi: 'बैटरी और सर्वर बचाने के लिए हमने अपडेट रोक दिए। फिर से जुड़ने के लिए नीचे टैप करें।' },
  'idle.reconnect':           { en: 'Reconnect',                  hi: 'फिर से जोड़ें' },
  'idle.tapDismiss':          { en: 'Or just tap anywhere to dismiss.', hi: 'या कहीं भी टैप करके बंद करें।' },
};


// ---------------------------------------------------------------------------
// Module state + pub/sub. Components subscribe via `useT()` and re-render
// when the language changes.
// ---------------------------------------------------------------------------
const loadLang = (): Lang => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved === 'en' || saved === 'hi') return saved;
  } catch {}
  // Auto-detect from browser. Fall back to English.
  if (typeof navigator !== 'undefined') {
    const n = navigator.language?.toLowerCase() || '';
    if (n.startsWith('hi')) return 'hi';
  }
  return 'en';
};

let currentLang: Lang = loadLang();
const subs = new Set<(lang: Lang) => void>();

export const getLang = (): Lang => currentLang;

export const setLang = (next: Lang): void => {
  if (next === currentLang) return;
  currentLang = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  document.documentElement.lang = next;
  for (const fn of subs) { try { fn(next); } catch {} }
};

// Initialise <html lang="...">
if (typeof document !== 'undefined') {
  document.documentElement.lang = currentLang;
}


/**
 * Look up a translation key. Falls back to English, then to the key string.
 *
 * Usage:  t('bills.title')
 *         t('bills.dueIn', { days: 3 })   ← simple variable interpolation
 */
export const t = (key: string, vars?: Record<string, string | number>): string => {
  const entry = dict[key];
  let str = entry ? (entry[currentLang] || entry.en) : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return str;
};


/**
 * React hook — re-renders on language change. Use t() inside your render code.
 */
export const useT = (): { t: typeof t; lang: Lang } => {
  const [lang, setLangState] = useState(currentLang);
  useEffect(() => {
    subs.add(setLangState);
    return () => { subs.delete(setLangState); };
  }, []);
  return { t, lang };
};


/** Subscribe outside React. */
export const onLangChange = (fn: (lang: Lang) => void): (() => void) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};
