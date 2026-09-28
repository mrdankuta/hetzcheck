import axios, { isAxiosError } from 'axios';
import { logger } from './logger';

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
}

/**
 * Sends notifications to Telegram (if configured).
 *
 * When Telegram is not configured, {@link Notifier.notifyAvailable} is a
 * no-op, so the rest of the app can call it unconditionally.
 */
export class Notifier {
  constructor(private readonly config: TelegramConfig) {}

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Notifies that a server type became available in a given location.
   * Safe to call when Telegram is disabled.
   */
  async notifyAvailable(
    serverType: string,
    location: string,
    when: string,
    specLines: string[] = [],
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const specsBlock =
      specLines.length > 0 ? `\n${specLines.join('\n')}\n` : '';

    const message =
      `🚀 Hetzner ${serverType.toUpperCase()} AVAILABLE!\n\n` +
      `Location: ${location}\n` +
      specsBlock +
      `\nTime: ${when}`;

    await this.sendMessage(message);
  }

  /**
   * Notifies that a server was auto-provisioned. Safe to call when
   * Telegram is disabled (no-op).
   */
  async notifyProvisioned(
    serverType: string,
    location: string,
    serverName: string,
    ipv4: string | null,
    when: string,
    specLines: string[] = [],
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const specsBlock =
      specLines.length > 0 ? `\n${specLines.join('\n')}\n` : '';
    const ipBlock = ipv4 ? `\nIP: ${ipv4}\n` : '';

    const message =
      `✅ Hetzner ${serverType.toUpperCase()} PROVISIONED!\n\n` +
      `Server: ${serverName}\n` +
      `Location: ${location}\n` +
      ipBlock +
      specsBlock +
      `\nTime: ${when}`;

    await this.sendMessage(message);
  }

  private async sendMessage(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;

    try {
      await axios.post(
        url,
        {
          chat_id: this.config.chatId,
          text,
          disable_web_page_preview: true,
        },
        { timeout: 15_000 },
      );
      logger.info('Telegram notification sent.');
    } catch (error) {
      // A failed notification must never crash the monitor loop.
      logger.error(`Failed to send Telegram notification: ${this.describe(error)}`);
    }
  }

  private describe(error: unknown): string {
    if (isAxiosError(error)) {
      const description = (error.response?.data as { description?: string })?.description;
      if (description) {
        return `${description} (HTTP ${error.response?.status ?? 'unknown'})`;
      }
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
