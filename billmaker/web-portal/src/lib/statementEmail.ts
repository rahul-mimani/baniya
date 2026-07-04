// HTML + plain-text bodies for the customer statement email. Both versions
// are sent so clients with text-only readers get something readable.
//
// The HTML uses inline styles (no <style> blocks) because most email clients
// strip or sandbox <style>. Table-based layout for the same reason — modern
// flexbox layouts break in Outlook.

export interface StatementEmailInput {
  customerName: string;
  shopName: string;
  shopPhone?: string;
  shopEmail?: string;
  portalUrl?: string;            // optional CTA — link to client portal
  periodLabel: string;           // e.g. "May 2026" or "01 May – 22 May 2026"
  billCount: number;
  totalBilled: number;
  totalPaid: number;
  outstanding: number;
  attachmentName: string;
}

const fmtMoney = (n: number): string =>
  `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const escape = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const buildEmailSubject = (input: StatementEmailInput): string =>
  `Your statement from ${input.shopName} — ${input.periodLabel}`;

export const buildHtmlBody = (input: StatementEmailInput): string => {
  const outstandingPositive = input.outstanding > 0.005;
  const accent = '#0284c7';     // sky-700 — matches the PDF
  const accentDark = '#0369a1'; // sky-800
  const text = '#1e293b';
  const muted = '#64748b';
  const lightBg = '#f8fafc';
  const due = '#dc2626';        // red-600
  const paid = '#10a36f';       // emerald-600

  const portalCta = input.portalUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px"><tr><td bgcolor="${accent}" style="border-radius:6px"><a href="${escape(input.portalUrl)}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px">View bills in portal &rarr;</a></td></tr></table>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escape(buildEmailSubject(input))}</title>
</head>
<body style="margin:0;padding:0;background-color:${lightBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:${text}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${lightBg}" style="background-color:${lightBg};padding:32px 16px">
    <tr><td align="center">

      <!-- Container -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08)">

        <!-- Header band -->
        <tr><td bgcolor="${accent}" style="background-color:${accent};background-image:linear-gradient(135deg,${accent},${accentDark});padding:32px 32px 24px 32px;color:#ffffff">
          <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.85)">Statement</p>
          <h1 style="margin:8px 0 4px 0;font-size:24px;font-weight:700;color:#ffffff">${escape(input.shopName)}</h1>
          <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85)">${escape(input.periodLabel)}</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px">
          <p style="margin:0 0 16px 0;font-size:16px;line-height:1.5">Hello ${escape(input.customerName)},</p>
          <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:${muted}">
            Here is your account statement for <strong style="color:${text}">${escape(input.periodLabel)}</strong>.
            A detailed PDF (<code style="font-family:monospace;font-size:12px;background:${lightBg};padding:2px 6px;border-radius:3px">${escape(input.attachmentName)}</code>) is attached with every bill, line items, and payment status.
          </p>

          <!-- Stats grid -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px 0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
            <tr>
              <td style="padding:16px;border-right:1px solid #e2e8f0;text-align:center;width:25%">
                <p style="margin:0;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${muted};font-weight:bold">Bills</p>
                <p style="margin:6px 0 0 0;font-size:22px;font-weight:700;color:${text}">${input.billCount}</p>
              </td>
              <td style="padding:16px;border-right:1px solid #e2e8f0;text-align:center;width:25%">
                <p style="margin:0;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${muted};font-weight:bold">Total Billed</p>
                <p style="margin:6px 0 0 0;font-size:18px;font-weight:700;color:${text}">${escape(fmtMoney(input.totalBilled))}</p>
              </td>
              <td style="padding:16px;border-right:1px solid #e2e8f0;text-align:center;width:25%">
                <p style="margin:0;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${muted};font-weight:bold">Paid</p>
                <p style="margin:6px 0 0 0;font-size:18px;font-weight:700;color:${paid}">${escape(fmtMoney(input.totalPaid))}</p>
              </td>
              <td style="padding:16px;text-align:center;width:25%">
                <p style="margin:0;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${muted};font-weight:bold">Outstanding</p>
                <p style="margin:6px 0 0 0;font-size:18px;font-weight:700;color:${outstandingPositive ? due : paid}">${escape(fmtMoney(input.outstanding))}</p>
              </td>
            </tr>
          </table>

          ${outstandingPositive
            ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px 0;background-color:#fef2f2;border-left:3px solid ${due};border-radius:4px"><tr><td style="padding:12px 16px"><p style="margin:0;font-size:13px;color:#7f1d1d"><strong>Outstanding balance:</strong> ${escape(fmtMoney(input.outstanding))}. We'd appreciate settlement at your earliest convenience.</p></td></tr></table>`
            : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px 0;background-color:#ecfdf5;border-left:3px solid ${paid};border-radius:4px"><tr><td style="padding:12px 16px"><p style="margin:0;font-size:13px;color:#065f46"><strong>All clear!</strong> No outstanding balance for this period. Thank you for your prompt payments.</p></td></tr></table>`}

          ${portalCta}

          <p style="margin:24px 0 0 0;font-size:13px;color:${muted};line-height:1.6">
            For any queries about this statement, just reply to this email${input.shopPhone ? ` or call <strong style="color:${text}">${escape(input.shopPhone)}</strong>` : ''}. We're happy to walk you through any individual bill.
          </p>

          <p style="margin:20px 0 0 0;font-size:13px;color:${muted}">
            Warm regards,<br>
            <strong style="color:${text}">${escape(input.shopName)}</strong>
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 32px;background-color:${lightBg};border-top:1px solid #e2e8f0">
          <p style="margin:0;font-size:11px;color:${muted};text-align:center">
            This is an automated statement.
            ${input.shopEmail ? `Email: <a href="mailto:${escape(input.shopEmail)}" style="color:${accent};text-decoration:none">${escape(input.shopEmail)}</a>` : ''}
            ${input.shopPhone ? ` &nbsp;·&nbsp; Phone: ${escape(input.shopPhone)}` : ''}
          </p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
};

export const buildTextBody = (input: StatementEmailInput): string => {
  const lines: string[] = [];
  lines.push(`Hello ${input.customerName},`);
  lines.push('');
  lines.push(`Here is your account statement for ${input.periodLabel}.`);
  lines.push(`A detailed PDF (${input.attachmentName}) is attached.`);
  lines.push('');
  lines.push('Summary:');
  lines.push(`  Bills:        ${input.billCount}`);
  lines.push(`  Total billed: ${fmtMoney(input.totalBilled)}`);
  lines.push(`  Paid:         ${fmtMoney(input.totalPaid)}`);
  lines.push(`  Outstanding:  ${fmtMoney(input.outstanding)}`);
  lines.push('');
  if (input.outstanding > 0.005) {
    lines.push(`Outstanding balance: ${fmtMoney(input.outstanding)}. We'd appreciate settlement at your earliest convenience.`);
  } else {
    lines.push(`All clear — no outstanding balance for this period. Thank you for your prompt payments.`);
  }
  lines.push('');
  if (input.portalUrl) {
    lines.push(`View bills in portal: ${input.portalUrl}`);
    lines.push('');
  }
  lines.push(`For any queries, reply to this email${input.shopPhone ? ` or call ${input.shopPhone}` : ''}.`);
  lines.push('');
  lines.push(`Warm regards,`);
  lines.push(input.shopName);
  return lines.join('\n');
};
