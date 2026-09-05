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
  secure?: boolean;
  requireTLS?: boolean;
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
      secure: opts.secure ?? false,
      requireTLS: opts.requireTLS ?? (opts.user !== undefined && opts.pass !== undefined),
      // nodemailer's default timeouts are minutes long, and every one of the
      // ~10 mail call sites in this codebase awaits send() on the request
      // path — a dead/slow SMTP server would otherwise hang a Fastify
      // handler for minutes. Mirrors webhooksTimeoutMs's role for the same
      // class of problem (see env.ts).
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  }
  async send(to: string, subject: string, text: string, html: string): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to, subject, text, html });
  }
}
