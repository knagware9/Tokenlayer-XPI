/**
 * Outbound email. `SmtpMailer` is the real transport (nodemailer over SMTP —
 * Mailpit in dev, a real provider's SMTP endpoint in production); `NullMailer`
 * is the test double every suite uses instead, mirroring how the webhook
 * dispatcher is tested without a live HTTP call.
 */
import nodemailer from "nodemailer";

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(to: string, subject: string, text: string, html: string): Promise<void>;
}

export class NullMailer implements Mailer {
  readonly sent: SentMail[] = [];
  async send(to: string, subject: string, text: string, html: string): Promise<void> {
    this.sent.push({ to, subject, text, html });
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

export class SmtpMailer implements Mailer {
  private readonly transporter: nodemailer.Transporter;
  constructor(private readonly from: string, opts: SmtpOptions) {
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      // Mailpit (dev) takes unauthenticated SMTP — omitting `auth` entirely
      // (not an empty-string user/pass) is what nodemailer requires to skip
      // the AUTH handshake a real provider would otherwise fail on.
      auth: opts.user && opts.pass ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }
  async send(to: string, subject: string, text: string, html: string): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to, subject, text, html });
  }
}
