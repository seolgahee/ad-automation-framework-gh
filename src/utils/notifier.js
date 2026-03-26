import logger from './logger.js';

/**
 * Unified notification dispatcher — sends alerts to Slack, Telegram,
 * and optionally the OpenClaw gateway for multi-channel relay.
 */
class Notifier {
  constructor() {
    this.slackBotToken = process.env.SLACK_BOT_TOKEN;
    this.slackChannel = process.env.SLACK_ALERT_CHANNEL || process.env.SLACK_CHANNEL;
    // Webhook kept as fallback only
    this.slackWebhook = process.env.SLACK_WEBHOOK_URL;
    this.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
  }

  /** Send to all configured channels */
  async broadcast(message, { severity = 'info', data = {} } = {}) {
    const results = await Promise.allSettled([
      this.sendSlack(message, severity, data),
      this.sendTelegram(message, severity),
    ]);

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        logger.warn(`Notification channel ${i} failed`, { error: r.reason?.message });
      }
    });
  }

  /** Slack via Bot Token (preferred) or Webhook (fallback) */
  async sendSlack(message, severity, data) {
    if (this.slackBotToken && this.slackChannel) {
      return this._sendSlackBot(message, severity, data);
    }
    if (this.slackWebhook) {
      return this._sendSlackWebhook(message, severity, data);
    }
  }

  /** Slack Bot Token — chat.postMessage (deletable, supports mentions) */
  async _sendSlackBot(message, severity, data) {
    const colorMap = { info: '#36a64f', warning: '#ff9900', critical: '#ff0000' };
    const payload = {
      channel: this.slackChannel,
      attachments: [{
        color: colorMap[severity] || colorMap.info,
        title: `📊 Ad Automation — ${severity.toUpperCase()}`,
        text: message,
        fields: Object.entries(data).map(([k, v]) => ({
          title: k, value: String(v), short: true,
        })),
        ts: Math.floor(Date.now() / 1000),
      }],
    };

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.slackBotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result = await res.json();
    if (!result.ok) throw new Error(`Slack Bot API: ${result.error}`);
    logger.debug('Slack notification sent via Bot Token', { ts: result.ts });
    return result;
  }

  /** Slack Webhook (fallback — messages cannot be deleted) */
  async _sendSlackWebhook(message, severity, data) {
    const colorMap = { info: '#36a64f', warning: '#ff9900', critical: '#ff0000' };
    const payload = {
      attachments: [{
        color: colorMap[severity] || colorMap.info,
        title: `📊 Ad Automation — ${severity.toUpperCase()}`,
        text: message,
        fields: Object.entries(data).map(([k, v]) => ({
          title: k, value: String(v), short: true,
        })),
        ts: Math.floor(Date.now() / 1000),
      }],
    };

    const res = await fetch(this.slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Slack ${res.status}: ${await res.text()}`);
    logger.debug('Slack notification sent via Webhook');
  }

  /** Telegram Bot API */
  async sendTelegram(message, severity) {
    if (!this.telegramToken || !this.telegramChatId) return;

    const icons = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
    const text = `${icons[severity] || icons.info} *Ad Automation*\n\n${message}`;

    const res = await fetch(
      `https://api.telegram.org/bot${this.telegramToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.telegramChatId,
          text,
          parse_mode: 'Markdown',
        }),
      }
    );

    if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
    logger.debug('Telegram notification sent');
  }
}

export const notifier = new Notifier();
export default notifier;
