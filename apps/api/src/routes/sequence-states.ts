import type { sequenceStates } from '@cooks/db';
import { ref, refOrNull } from '@cooks/core';

/** Shared serializer used by prospect includes; the full sequenceStates routes land in M2. */
export function serializeSequenceStateRow(s: typeof sequenceStates.$inferSelect) {
  return {
    id: s.id,
    state: s.state,
    sequence: ref('sequences', s.sequenceId),
    prospect: ref('prospects', s.prospectId),
    account: refOrNull('accounts', s.accountId),
    creator: ref('users', s.creatorId ?? s.ownerId),
    owner: ref('users', s.ownerId),
    sequenceStep: refOrNull('sequenceSteps', s.currentStepId),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
