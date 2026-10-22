import { ImapFlow } from 'imapflow';
import { parseRfc822 } from './parse.js';
import type { InboundMessage, InboundProvider, SyncCursor } from './provider.js';

export interface ImapSettings {
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  pass: string;
  mailbox?: string;
}

/** Parse smtp://user:pass@host:port or imaps://... URLs into settings. */
export function parseMailUrl(url: string): { host: string; port: number; secure: boolean; user: string; pass: string } {
  const u = new URL(url);
  const secure = u.protocol === 'imaps:' || u.protocol === 'smtps:' || u.port === '993' || u.port === '465';
  return { host: u.hostname, port: Number(u.port) || (u.protocol.startsWith('imap') ? (secure ? 993 : 143) : secure ? 465 : 587), secure, user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
}

/**
 * IMAP inbox reader. Cursor = { uidValidity, lastUid }. Only new UIDs are fetched, so the
 * first sync after connecting starts from "now" (it does not import history).
 */
export class ImapProvider implements InboundProvider {
  constructor(
    private settings: ImapSettings,
    private limit = 200,
  ) {}

  async sync(cursor: SyncCursor | null): Promise<{ messages: InboundMessage[]; cursor: SyncCursor }> {
    const client = new ImapFlow({
      host: this.settings.host,
      port: this.settings.port ?? 993,
      secure: this.settings.secure ?? true,
      auth: { user: this.settings.user, pass: this.settings.pass },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock(this.settings.mailbox ?? 'INBOX');
      try {
        const box = client.mailbox;
        if (!box) return { messages: [], cursor: cursor ?? {} };
        const uidValidity = String(box.uidValidity);
        let lastUid = cursor && cursor.uidValidity === uidValidity ? Number(cursor.lastUid ?? 0) : 0;
        if (!cursor || cursor.uidValidity !== uidValidity) {
          // fresh cursor: start at the current high-water mark
          lastUid = Math.max(0, (box.uidNext ?? 1) - 1);
          return { messages: [], cursor: { uidValidity, lastUid } };
        }
        const messages: InboundMessage[] = [];
        let maxUid = lastUid;
        for await (const m of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (m.uid <= lastUid) continue;
          if (m.source) messages.push(await parseRfc822(m.source, `imap:${uidValidity}:${m.uid}`));
          maxUid = Math.max(maxUid, m.uid);
          if (messages.length >= this.limit) break;
        }
        return { messages, cursor: { uidValidity, lastUid: maxUid } };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }
}
