import { config } from './config';

// Template content for the two transactional emails (Component 3, REQ-3.1).
// Deliberately dependency-free: template literals only, no template engine and
// no React. `text` is authoritative; `html` is the same content in one shared,
// branded layout — inline styles (email clients strip <style>/classes), a
// LIGHT base with a dark-mode @media *progressive enhancement* (clients that
// honor prefers-color-scheme get the brand-canonical dark surface; the rest
// keep the robust light base). The link carries the raw token in the URL
// fragment (`#token=`, D6) so it never reaches either origin's server logs
// (REQ-3.9); the raw token appears nowhere but the link.
//
// Invariants the unit tests pin (email-templates.test.ts) and the design honors:
//   - no <img> (the wordmark is live text `[▴] Tradr`, not a hosted image),
//   - the link is the ONLY url — the CTA button and the paste-in link share the
//     same href, and there is no other http(s) reference (no `http-equiv`, no
//     `xmlns="http…"`, no footer link),
//   - the token is only ever inside the link.

export type EmailKind = 'password_reset' | 'email_verification';

export type EmailContent = {
  subject: string;
  text: string;
  html: string;
};

type EmailParts = {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  link: string;
  cta: string;
  expiry: string;
  notice: string;
};

// Font stacks: brand faces (Inter / JetBrains Mono) are a bonus that only loads
// in a few clients (Apple Mail, some webmail); Outlook and Gmail fall back to the
// system stacks below, so the design is built to read on the fallback.
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace";

// One shared rendering for both kinds: the plain-text body and the branded HTML
// layout are built from the same parts, so the two variants cannot drift.
function render(parts: EmailParts): EmailContent {
  const { subject, preheader, heading, intro, link, cta, expiry, notice } = parts;

  // The instance's own web host for the footer — a self-host shows its own domain,
  // never a hardcoded hosted brand. WEB_BASE_URL is origin-only + validated, so
  // `.host` is safe; read at call time (never captured at module load, per the
  // no-capture rule). Bare host (no scheme) keeps the "link is the only URL" invariant.
  const webHost = config.WEB_BASE_URL ? new URL(config.WEB_BASE_URL).host : '';

  // Authoritative plain-text body (unchanged shape — intro, link, expiry, notice).
  const text = `${intro}\n\n${link}\n\n${expiry}\n\n${notice}\n`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${subject}</title>
<style>
  /* Dark-mode progressive enhancement. Clients that honor prefers-color-scheme
     (Apple Mail, much webmail) get the brand-canonical dark surface; clients that
     strip <style> or ignore the query (Gmail, Outlook) keep the light base above. */
  @media (prefers-color-scheme: dark) {
    .t-bg { background:#0f1216 !important; }
    .t-card { background:#14181f !important; border-color:#262c36 !important; }
    .t-fg { color:#f2f4f7 !important; }
    .t-muted { color:#a3a9b3 !important; }
    .t-wordmark { color:#f2f4f7 !important; }
    .t-box { background:#1b202a !important; border-color:#2a3039 !important; }
    .t-link { color:#ecb65f !important; }
    .t-hair { border-color:#262c36 !important; }
  }
</style>
</head>
<body class="t-bg" style="margin:0;padding:0;background:#f4f4f5;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="t-bg" style="background:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" class="t-card" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #e6e7ea;border-radius:14px;overflow:hidden;">
<tr><td style="height:3px;background:#e6a23c;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 0;">
  <span style="font-family:${MONO};font-size:20px;font-weight:700;color:#e6a23c;letter-spacing:-0.02em;">[&#9652;]</span>
  <span class="t-wordmark" style="font-family:${SANS};font-size:19px;font-weight:700;color:#191c22;padding-left:6px;">Tradr</span>
</td></tr>
<tr><td style="padding:20px 32px 0;"><div class="t-hair" style="border-top:1px solid #e6e7ea;font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td style="padding:24px 32px 0;">
  <h1 class="t-fg" style="margin:0;font-family:${SANS};font-size:23px;font-weight:600;color:#191c22;letter-spacing:-0.01em;">${heading}</h1>
  <p class="t-muted" style="margin:14px 0 0;font-family:${SANS};font-size:16px;line-height:1.6;color:#5c626b;">${intro}</p>
</td></tr>
<tr><td style="padding:24px 32px 0;">
  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${link}" style="height:46px;v-text-anchor:middle;width:230px;" arcsize="18%" fillcolor="#e6a23c" stroke="f"><center style="color:#1c1608;font-family:sans-serif;font-size:15px;font-weight:bold;">${cta}</center></v:roundrect><![endif]-->
  <!--[if !mso]><!-- --><a href="${link}" style="display:inline-block;background:#e6a23c;color:#1c1608;font-family:${SANS};font-size:15px;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:8px;">${cta}</a><!--<![endif]-->
</td></tr>
<tr><td style="padding:22px 32px 0;">
  <p class="t-muted" style="margin:0 0 8px;font-family:${SANS};font-size:14px;color:#5c626b;">Or paste this link into your browser:</p>
  <div class="t-box" style="border:1px solid #e6e7ea;background:#f7f7f8;border-radius:8px;padding:12px 14px;">
    <a href="${link}" class="t-link" style="font-family:${MONO};font-size:13px;color:#935608;text-decoration:none;word-break:break-all;">${link}</a>
  </div>
</td></tr>
<tr><td style="padding:14px 32px 0;">
  <span class="t-box t-muted" style="display:inline-block;font-family:${MONO};font-size:12px;color:#5c626b;border:1px solid #e6e7ea;background:#f7f7f8;border-radius:6px;padding:5px 10px;">${expiry}</span>
</td></tr>
<tr><td style="padding:24px 32px 0;"><div class="t-hair" style="border-top:1px solid #e6e7ea;font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td style="padding:18px 32px 28px;">
  <p class="t-muted" style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:#5c626b;">${notice}</p>
</td></tr>
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:20px 32px;">
  <p class="t-muted" style="margin:0;font-family:${SANS};font-size:13px;color:#5c626b;">Tradr &mdash; the open-source trading journal${webHost ? ` &middot; ${webHost}` : ''}</p>
  <p class="t-muted" style="margin:6px 0 0;font-family:${SANS};font-size:12px;color:#8b919b;">This is an automated, transactional message about your Tradr account.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

/**
 * Build the subject/text/html content for one transactional email kind.
 * `config.WEB_BASE_URL` is read at CALL time — never captured at module load
 * (the Task 1 no-capture rule) — so config transitions and per-test mutation
 * are always honored. The mailer only dispatches when `isEmailConfigured()`
 * is true, so WEB_BASE_URL is always present on real sends; the `?? ''`
 * fallback merely keeps the type narrow.
 */
export function buildEmail(kind: EmailKind, rawToken: string): EmailContent {
  const base = config.WEB_BASE_URL ?? '';
  if (kind === 'password_reset') {
    return render({
      subject: 'Reset your Tradr password',
      preheader: 'Reset your Tradr password — this link expires in 60 minutes.',
      heading: 'Reset your password',
      intro: 'We received a request to reset the password for your Tradr account.',
      link: `${base}/reset-password#token=${rawToken}`,
      cta: 'Reset password',
      expiry: 'This link expires in 60 minutes.',
      notice: "If you didn't request this, you can ignore this email — your password is unchanged.",
    });
  }
  return render({
    subject: 'Verify your email address',
    preheader: 'Verify your email address to finish setting up Tradr.',
    heading: 'Confirm your email address',
    intro: 'Confirm this email address for your Tradr account by opening the link below.',
    link: `${base}/verify-email#token=${rawToken}`,
    cta: 'Verify email address',
    expiry: 'This link expires in 24 hours.',
    notice: "If you didn't request this, you can ignore this email.",
  });
}
