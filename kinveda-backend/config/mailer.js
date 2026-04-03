/**
 * KinVeda Mailer
 * Nodemailer transporter + templated email senders.
 */
require('dotenv').config();
const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }
  return transporter;
}

const ADMIN_EMAILS = (process.env.ADMIN_EMAIL_IDS || '')
  .split(',').map(e => e.trim()).filter(Boolean);

// ─── Shared HTML wrapper ──────────────────────────────────────────────────────
function wrapHtml(title, bodyHtml) {
  return `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{font-family:'Segoe UI',sans-serif;background:#F7F4EF;margin:0;padding:0;}
  .wrapper{max-width:600px;margin:30px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2EAE8;}
  .header{background:linear-gradient(135deg,#2D7D6F,#4A9D8E);padding:28px 32px;color:white;}
  .header h1{margin:0;font-size:22px;font-weight:800;}
  .header p{margin:6px 0 0;font-size:13px;opacity:.85;}
  .body{padding:28px 32px;}
  .body p{font-size:14px;line-height:1.7;color:#1A2E2A;}
  .field{background:#F7F4EF;border-radius:8px;padding:12px 16px;margin:12px 0;font-size:13px;}
  .field strong{display:block;font-size:11px;color:#6B7F7C;text-transform:uppercase;margin-bottom:4px;}
  .btn{display:inline-block;background:#2D7D6F;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin-top:16px;}
  .footer{background:#F7F4EF;padding:16px 32px;font-size:11px;color:#6B7F7C;text-align:center;}
  .sos-banner{background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;padding:12px 16px;color:#7F1D1D;font-size:13px;margin-top:16px;}
</style>
</head><body>
<div class="wrapper">
  <div class="header">
    <h1>🌿 KinVeda</h1>
    <p>${title}</p>
  </div>
  <div class="body">${bodyHtml}</div>
  <div class="footer">KinVeda · India's Family Wellness Portal · Confidential & Encrypted</div>
</div>
</body></html>`;
}

// ─── Email Senders ────────────────────────────────────────────────────────────

async function sendWelcomeEmail(to, name, role) {
  const roleLabel = role === 'kinmentor' ? 'KinMentor' : 'KinMember';
  const dashboardUrl = role === 'kinmentor'
    ? `${process.env.FRONTEND_URL}/kinveda-kinmentor.html`
    : `${process.env.FRONTEND_URL}/kinveda-kinmember.html`;

  await getTransporter().sendMail({
    from: `"KinVeda" <${process.env.SMTP_USER}>`,
    to,
    subject: `Welcome to KinVeda, ${name}!`,
    html: wrapHtml('Welcome to KinVeda', `
      <p>Hello <strong>${name}</strong>,</p>
      <p>Your KinVeda account has been created as a <strong>${roleLabel}</strong>.</p>
      <p>You can now sign in and access your personalised dashboard to begin your wellness journey.</p>
      <a href="${dashboardUrl}" class="btn">Go to My Dashboard →</a>
      <p style="margin-top:24px;font-size:13px;color:#6B7F7C;">If you did not create this account, please ignore this email.</p>
    `)
  });
}

async function sendAdminChatNotification(enquiry) {
  if (!ADMIN_EMAILS.length) return;
  await getTransporter().sendMail({
    from: `"KinVeda Chat" <${process.env.SMTP_USER}>`,
    to: ADMIN_EMAILS.join(', '),
    subject: `[KinVeda] New Chat Enquiry from ${enquiry.name || 'Anonymous'}`,
    html: wrapHtml('New Chat Enquiry — Action Required', `
      <p>A visitor has used the <strong>"Chat with Us"</strong> widget. Please respond within 2 hours.</p>
      <div class="field"><strong>Name</strong>${enquiry.name || 'Not provided'}</div>
      <div class="field"><strong>Email</strong>${enquiry.email || 'Not provided'}</div>
      <div class="field"><strong>Message</strong>${enquiry.message}</div>
      <div class="field"><strong>Page</strong>${enquiry.sourcePage || 'Unknown'}</div>
      <div class="field"><strong>Time</strong>${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</div>
      <a href="${process.env.FRONTEND_URL}${process.env.ADMIN_ROUTE_PREFIX}" class="btn">Open Admin Panel →</a>
    `)
  });
}

async function sendSOSAlert(sosEvent, userName) {
  if (!ADMIN_EMAILS.length) return;
  await getTransporter().sendMail({
    from: `"KinVeda SOS" <${process.env.SMTP_USER}>`,
    to: ADMIN_EMAILS.join(', '),
    subject: `🆘 [URGENT] KinVeda SOS Alert — ${userName || 'Anonymous User'}`,
    html: wrapHtml('🆘 SOS Alert — Immediate Action Required', `
      <div class="sos-banner">
        ⚠️ This is an automated SOS alert. Please follow up within 1 hour.
      </div>
      <div class="field"><strong>User</strong>${userName || 'Anonymous'}</div>
      <div class="field"><strong>Trigger</strong>${sosEvent.trigger_type}</div>
      <div class="field"><strong>Time</strong>${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</div>
      <p>Please log in to the admin panel and assign a follow-up action immediately.</p>
      <a href="${process.env.FRONTEND_URL}${process.env.ADMIN_ROUTE_PREFIX}" class="btn">Open Admin Panel →</a>
    `)
  });
}

async function sendSessionConfirmation(toEmail, memberName, mentorName, scheduledAt, amount) {
  const sessionDate = new Date(scheduledAt * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short'
  });
  await getTransporter().sendMail({
    from: `"KinVeda Sessions" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `Session Confirmed — ${sessionDate}`,
    html: wrapHtml('Session Confirmed', `
      <p>Hello <strong>${memberName}</strong>,</p>
      <p>Your session has been confirmed. Details below:</p>
      <div class="field"><strong>KinMentor</strong>${mentorName}</div>
      <div class="field"><strong>Date & Time</strong>${sessionDate} IST</div>
      <div class="field"><strong>Amount Paid</strong>₹${amount}</div>
      <p>A calendar invite has been sent to your email. You can join the session from your dashboard.</p>
      <a href="${process.env.FRONTEND_URL}/kinveda-kinmember.html" class="btn">Go to My Sessions →</a>
    `)
  });
}

async function sendPasswordReset(toEmail, resetUrl) {
  await getTransporter().sendMail({
    from: `"KinVeda" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: 'Reset Your KinVeda Password',
    html: wrapHtml('Password Reset Request', `
      <p>We received a request to reset your KinVeda password.</p>
      <p>Click the button below. This link expires in <strong>1 hour</strong>.</p>
      <a href="${resetUrl}" class="btn">Reset My Password →</a>
      <p style="margin-top:20px;font-size:12px;color:#6B7F7C;">If you did not request this, please ignore this email. Your account is safe.</p>
    `)
  });
}

// ─── Session Scheduled by Admin (notify KinMember) ───────────────────────────
async function sendSessionScheduledEmail(toEmail, memberName, mentorName, scheduledAt, durationMins) {
  const sessionDate = new Date(scheduledAt * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short'
  });
  await getTransporter().sendMail({
    from: `"KinVeda Sessions" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `📅 Your Session Has Been Scheduled — ${sessionDate}`,
    html: wrapHtml('Session Scheduled for You', `
      <p>Hello <strong>${memberName}</strong>,</p>
      <p>Great news! A session has been scheduled for you with your KinMentor.</p>
      <div class="field"><strong>KinMentor</strong>${mentorName}</div>
      <div class="field"><strong>Date & Time (IST)</strong>${sessionDate}</div>
      <div class="field"><strong>Duration</strong>${durationMins} minutes</div>
      <p>Please log in to your dashboard to confirm payment and get your session join link.</p>
      <a href="${process.env.FRONTEND_URL}/kinveda-kinmember.html" class="btn">View My Sessions →</a>
      <p style="margin-top:16px;font-size:12px;color:#6B7F7C;">All sessions are encrypted and private. 🔒</p>
    `)
  });
}

// ─── Upcoming Session Reminder (sent at scheduled time − 15 min) ─────────────
async function sendSessionReminderEmail(toEmail, recipientName, otherPartyName, scheduledAt, videoRoom, role) {
  const sessionDate = new Date(scheduledAt * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short'
  });
  const dashboardUrl = role === 'kinmentor'
    ? `${process.env.FRONTEND_URL}/kinveda-kinmentor.html`
    : `${process.env.FRONTEND_URL}/kinveda-kinmember.html`;

  await getTransporter().sendMail({
    from: `"KinVeda Sessions" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `⏰ Reminder: Your session starts in 15 minutes!`,
    html: wrapHtml('Session Starting Soon', `
      <p>Hello <strong>${recipientName}</strong>,</p>
      <p>Your KinVeda session starts in <strong>15 minutes</strong>.</p>
      <div class="field"><strong>${role === 'kinmentor' ? 'KinMember' : 'KinMentor'}</strong>${otherPartyName}</div>
      <div class="field"><strong>Time (IST)</strong>${sessionDate}</div>
      <p>Click the button below to open your dashboard and join the session.</p>
      <a href="${dashboardUrl}" class="btn">Join Session Now →</a>
      <p style="margin-top:16px;font-size:12px;color:#6B7F7C;">Please join 2–3 minutes early to test your audio and video.</p>
    `)
  });
}

// ─── Notes / Homework Assigned to KinMember ──────────────────────────────────
async function sendNotesAssignedEmail(toEmail, memberName, mentorName, taskSummary) {
  await getTransporter().sendMail({
    from: `"KinVeda Sessions" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `📝 Your KinMentor has shared notes & homework with you`,
    html: wrapHtml('New Notes from Your KinMentor', `
      <p>Hello <strong>${memberName}</strong>,</p>
      <p>Your KinMentor <strong>${mentorName}</strong> has added notes or a homework task for you.</p>
      ${taskSummary ? `<div class="field"><strong>Task</strong>${taskSummary}</div>` : ''}
      <p>Log in to your dashboard to review your notes and complete your homework.</p>
      <a href="${process.env.FRONTEND_URL}/kinveda-kinmember.html" class="btn">View My Homework →</a>
    `)
  });
}

// ─── Payment / Purchase Confirmation ─────────────────────────────────────────
async function sendPaymentConfirmationEmail(toEmail, memberName, description, amountInr, txnId) {
  const paidAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  await getTransporter().sendMail({
    from: `"KinVeda Payments" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `✅ Payment Confirmed — ₹${amountInr} received`,
    html: wrapHtml('Payment Confirmation', `
      <p>Hello <strong>${memberName}</strong>,</p>
      <p>We have successfully received your payment. Thank you!</p>
      <div class="field"><strong>Description</strong>${description}</div>
      <div class="field"><strong>Amount Paid</strong>₹${amountInr}</div>
      <div class="field"><strong>Transaction ID</strong>${txnId || 'N/A'}</div>
      <div class="field"><strong>Date & Time (IST)</strong>${paidAt}</div>
      <a href="${process.env.FRONTEND_URL}/kinveda-kinmember.html" class="btn">View My Billing →</a>
      <p style="margin-top:16px;font-size:12px;color:#6B7F7C;">Please keep this email as your payment receipt.</p>
    `)
  });
}

// ─── Mentor Payout Invoice ────────────────────────────────────────────────────
async function sendMentorPayoutInvoice(toEmail, mentorName, grossAmount, platformCut, payoutAmount, periodLabel, sessions, transferRef, mode) {
  const sentAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  await getTransporter().sendMail({
    from: `"KinVeda Finance" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `💰 KinVeda Payout — ₹${payoutAmount} for ${periodLabel}`,
    html: wrapHtml('Your Weekly Payout Invoice', `
      <p>Hello <strong>${mentorName}</strong>,</p>
      <p>Your KinVeda earnings for <strong>${periodLabel}</strong> have been processed.</p>
      <div class="field"><strong>Sessions Covered</strong>${sessions}</div>
      <div class="field"><strong>Gross Earnings</strong>₹${grossAmount}</div>
      <div class="field"><strong>KinVeda Platform Fee (20%)</strong>−₹${platformCut}</div>
      <div class="field" style="background:#D1FAE5;"><strong>Net Payout to You</strong>₹${payoutAmount}</div>
      <div class="field"><strong>Payment Mode</strong>${mode === 'offline' ? 'Offline / Manual Transfer' : 'Online Bank Transfer'}</div>
      ${transferRef ? `<div class="field"><strong>Reference / UTR</strong>${transferRef}</div>` : ''}
      <div class="field"><strong>Processed On</strong>${sentAt}</div>
      <a href="${process.env.FRONTEND_URL}/kinveda-kinmentor.html" class="btn">View My Earnings →</a>
      <p style="margin-top:16px;font-size:12px;color:#6B7F7C;">Payouts are processed every Tuesday. KinVeda retains 20% as platform commission.</p>
    `)
  });
}

// ─── Session Request Received (member requested a session) ───────────────────
async function sendSessionRequestedEmail(adminEmail, memberName, mentorName, durationMins, message) {
  await getTransporter().sendMail({
    from: `"KinVeda Admin" <${process.env.SMTP_USER}>`,
    to: adminEmail,
    subject: `📋 New Session Request — ${memberName} → ${mentorName}`,
    html: wrapHtml('New Session Request', `
      <p>A KinMember has requested a session. Please log in to approve it with a date and time.</p>
      <div class="field"><strong>KinMember</strong>${memberName}</div>
      <div class="field"><strong>Requested KinMentor</strong>${mentorName}</div>
      <div class="field"><strong>Duration Requested</strong>${durationMins} minutes</div>
      ${message ? `<div class="field"><strong>Member's Note</strong>${message}</div>` : ''}
      <a href="${process.env.FRONTEND_URL}/kinveda-admin.html" class="btn">Review & Approve →</a>
    `)
  });
}

// ─── Session Approved — sent to BOTH member and mentor ───────────────────────
async function sendSessionApprovedEmail(toEmail, recipientName, otherPartyName, scheduledAt, durationMins, role) {
  const sessionDate = new Date(scheduledAt * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short'
  });
  const isMember = role === 'kinmember';
  const dashboardUrl = isMember
    ? `${process.env.FRONTEND_URL}/kinveda-kinmember.html`
    : `${process.env.FRONTEND_URL}/kinveda-kinmentor.html`;

  await getTransporter().sendMail({
    from: `"KinVeda Sessions" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `✅ Session Approved — ${sessionDate}`,
    html: wrapHtml('Your Session is Confirmed!', `
      <p>Hello <strong>${recipientName}</strong>,</p>
      <p>Your KinVeda session has been <strong>approved and confirmed</strong>.</p>
      <div class="field"><strong>${isMember ? 'Your KinMentor' : 'KinMember'}</strong>${otherPartyName}</div>
      <div class="field"><strong>Date & Time (IST)</strong>${sessionDate}</div>
      <div class="field"><strong>Duration</strong>${durationMins} minutes</div>
      <p>${isMember
        ? 'Log in to your dashboard to see the session details and join the live call when it starts.'
        : 'Log in to your dashboard to start the session at the scheduled time.'
      }</p>
      <a href="${dashboardUrl}" class="btn">${isMember ? 'View My Sessions →' : 'Go to Dashboard →'}</a>
      <p style="margin-top:16px;font-size:12px;color:#6B7F7C;">All sessions are encrypted and private. 🔒</p>
    `)
  });
}

module.exports = {
  sendWelcomeEmail,
  sendAdminChatNotification,
  sendSOSAlert,
  sendSessionConfirmation,
  sendSessionScheduledEmail,
  sendSessionReminderEmail,
  sendNotesAssignedEmail,
  sendPaymentConfirmationEmail,
  sendMentorPayoutInvoice,
  sendPasswordReset,
  sendSessionRequestedEmail,
  sendSessionApprovedEmail
};
