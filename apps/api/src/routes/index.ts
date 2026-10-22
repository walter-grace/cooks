import type { Registrar } from '../register.js';
import { mountAccounts } from './accounts.js';
import { mountMe } from './me.js';
import { mountProspects } from './prospects.js';
import { mountTags } from './tags.js';
import { mountUsers } from './users.js';

export function mountRoutes(reg: Registrar, opts: { publicIps: string[] }) {
  mountMe(reg, opts);
  mountUsers(reg);
  mountAccounts(reg);
  mountProspects(reg);
  mountTags(reg);
}
