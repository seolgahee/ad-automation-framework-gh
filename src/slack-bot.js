/**
 * Slack Bot — Socket Mode
 *
 * Listens for @mentions and routes to AdManagerSkill chat handler.
 * Runs alongside the main server (import and call startSlackBot).
 *
 * Required env:
 *   SLACK_BOT_TOKEN=xoxb-...
 *   SLACK_APP_TOKEN=xapp-...
 */
import pkg from '@slack/bolt';
const { App } = pkg;
import { AdManagerSkill } from './openclaw-skills/ad-manager.skill.js';
import logger from './utils/logger.js';

const skill = new AdManagerSkill();

let app;

export async function startSlackBot() {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    logger.warn('Slack Bot not started — SLACK_BOT_TOKEN or SLACK_APP_TOKEN missing');
    return;
  }

  app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  // Handle @mentions
  app.event('app_mention', async ({ event, say }) => {
    try {
      // Strip the bot mention tag to get the actual message
      const message = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

      if (!message) {
        await say({
          text: '안녕하세요! 광고 관리 AI입니다. 무엇을 도와드릴까요?\n\n사용 가능한 명령어:\n• 성과 보여줘\n• 캠페인 목록\n• 최적화 추천\n• 알림 확인\n• 예산 늘려줘\n• 캠페인 일시정지',
          thread_ts: event.ts,
        });
        return;
      }

      logger.info('Slack mention received', { user: event.user, message });

      const reply = await skill.handleMessage(message, { user: event.user });

      await say({
        text: reply,
        thread_ts: event.ts,
      });
    } catch (err) {
      logger.error('Slack bot error', { error: err.message });
      await say({
        text: '처리 중 오류가 발생했습니다. 다시 시도해주세요.',
        thread_ts: event.ts,
      });
    }
  });

  await app.start();
  logger.info('Slack Bot started (Socket Mode)');
}

export default startSlackBot;
