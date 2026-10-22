import type { Ctx } from '../context.js';
import { badRequest } from '../errors.js';
import { connectHubspot, disconnectCrm, runAutoEnrollRule, serializeConnection, syncHubspotContacts, updateCrmSettings, type AutoEnrollRule, type CrmDeps } from '../crm/connector.js';
import { uuidv7 } from '@cooks/db';

export { connectHubspot, disconnectCrm, serializeConnection, syncHubspotContacts, updateCrmSettings, runAutoEnrollRule };

export async function addAutoEnrollRule(ctx: Ctx, input: Omit<AutoEnrollRule, 'id' | 'enabled'> & { enabled?: boolean }, d: CrmDeps) {
  if (input.kind === 'list' && !input.listId) throw badRequest('listId is required for list rules');
  if (input.kind === 'dealStage' && (!input.pipelineId || !input.stageId)) throw badRequest('pipelineId and stageId are required for dealStage rules');
  const current = await serializeConnection(ctx, d);
  const rules = [...current.settings.autoEnroll, { ...input, id: uuidv7(), enabled: input.enabled ?? true }];
  return updateCrmSettings(ctx, { autoEnroll: rules }, d);
}

export async function removeAutoEnrollRule(ctx: Ctx, id: string, d: CrmDeps) {
  const current = await serializeConnection(ctx, d);
  return updateCrmSettings(ctx, { autoEnroll: current.settings.autoEnroll.filter((r) => r.id !== id) }, d);
}
