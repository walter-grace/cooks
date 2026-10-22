import type { Registrar } from '../register.js';
import { mountAccounts } from './accounts.js';
import { mountEmailTemplates } from './email-templates.js';
import { mountMe } from './me.js';
import { mountProspects } from './prospects.js';
import { mountSequenceStates } from './sequence-states.js';
import { mountSequenceSteps } from './sequence-steps.js';
import { mountSequences } from './sequences.js';
import { mountTags } from './tags.js';
import { mountTasks } from './tasks.js';
import { mountUsers } from './users.js';

export function mountRoutes(reg: Registrar, opts: { publicIps: string[] }) {
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
}
