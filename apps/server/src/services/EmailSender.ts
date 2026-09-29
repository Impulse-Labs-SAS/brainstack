// Outgoing email: verification links, password resets and invitations.
//
// Two ways to send, both optional: Resend's API, or any SMTP server (Gmail,
// Outlook, a company relay, Resend's own SMTP endpoint). Without either, the
// instance has no email at all, and the services that need one say so instead
// of pretending to have sent it. Nothing ever writes a message to the log: a
// verification or reset link is the account, and a log is read by more people
// than the inbox it was meant for.

import nodemailer, { type Transporter } from 'nodemailer';
import { Resend } from 'resend';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    if (error) {
      throw new Error(`resend failed: ${error.message ?? String(error)}`);
    }
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** TLS from the first byte (port 465). Otherwise STARTTLS, required except on localhost. */
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
}

export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(
    options: SmtpOptions,
    private readonly from: string,
  ) {
    const local = ['localhost', '127.0.0.1', '::1'].includes(options.host);
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      // Without `secure`, the upgrade to TLS is offered by the server, and
      // whoever sits in between can strip the offer and read the credentials.
      // Insist on it, except for a mail catcher on this machine, which has no
      // certificate to offer.
      requireTLS: !options.secure && !local,
      ...(options.user ? { auth: { user: options.user, pass: options.password ?? '' } } : {}),
      // A dead mail host otherwise holds a sign-up open until the platform kills it.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}

export interface EmailConfig {
  resendApiKey?: string | undefined;
  smtp?: SmtpOptions | undefined;
  from?: string | undefined;
}

/**
 * The sender this configuration asks for, or null when it asks for none.
 * Resend wins when both are set. Either one needs a From address.
 */
export function createEmailSender(cfg: EmailConfig): EmailSender | null {
  if (!cfg.from) return null;
  if (cfg.resendApiKey) return new ResendEmailSender(cfg.resendApiKey, cfg.from);
  if (cfg.smtp) return new SmtpEmailSender(cfg.smtp, cfg.from);
  return null;
}

export class CapturingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
