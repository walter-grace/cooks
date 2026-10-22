import type { Registrar } from '../register.js';
import { mountAccounts } from './accounts.js';
import { mountCalls } from './calls.js';
import { mountEmails } from './emails.js';
import { mountMailboxes } from './mailboxes.js';
import { mountEmailTemplates } from './email-templates.js';
import { mountMe } from './me.js';
import { mountProspects } from './prospects.js';
import { mountSequenceStates } from './sequence-states.js';
import { mountSequenceSteps } from './sequence-steps.js';
import { mountSequences } from './sequences.js';
import { mountTags } from './tags.js';
import { mountTasks } from './tasks.js';
import { mountUsers } from './users.js';
import { mountWebhooks } from './webhooks.js';
import { mountWorkspace } from './workspace.js';

export function mountRoutes(reg: Registrar, opts: { publicIps: string[]; kek?: string; fetchImpl?: typeof fetch; keyPrefix?: 'cooks' | 'nooks' }) {
  mountMe(reg, opts);
  mountUsers(reg);
  mountAccounts(reg);
  mountProspects(reg);
  mountTags(reg);
  mountSequences(reg);
  mountSequenceSteps(reg);
  mountSequenceStates(reg);
  mountTasks(reg);
  mountEmailTemplates(reg);
  mountEmails(reg);
  mountMailboxes(reg, { kek: opts.kek });
  mountCalls(reg);
  mountWebhooks(reg, { kek: opts.kek, fetchImpl: opts.fetchImpl });
  mountWorkspace(reg, { keyPrefix: opts.keyPrefix ?? 'cooks' });
}
