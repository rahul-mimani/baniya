const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const TEENS = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const twoDigit = (n: number): string => {
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ` ${ONES[o]}` : '');
};

const threeDigit = (n: number): string => {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigit(rest));
  return parts.join(' ');
};

/** Indian-English amount in words: lakh/crore-style grouping, plus paise. */
export const numberToIndianWords = (amount: number): string => {
  if (!isFinite(amount) || amount < 0) return '';
  if (amount === 0) return 'Zero Rupees Only';

  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);

  const rupeeParts: string[] = [];
  if (rupees > 0) {
    const crore = Math.floor(rupees / 10000000);
    const lakh = Math.floor((rupees % 10000000) / 100000);
    const thousand = Math.floor((rupees % 100000) / 1000);
    const hundred = rupees % 1000;

    if (crore) rupeeParts.push(`${twoDigit(crore)} Crore`);
    if (lakh) rupeeParts.push(`${twoDigit(lakh)} Lakh`);
    if (thousand) rupeeParts.push(`${twoDigit(thousand)} Thousand`);
    if (hundred) rupeeParts.push(threeDigit(hundred));
  }

  let out = rupeeParts.length ? `${rupeeParts.join(' ')} Rupees` : '';
  if (paise > 0) {
    out += (out ? ' and ' : '') + `${twoDigit(paise)} Paise`;
  }
  return `${out} Only`;
};
