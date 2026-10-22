import type { Ctx, Principal } from '@cooks/core';

export type AppEnv = {
  Variables: {
    traceId: string;
    principal: Principal;
    ctx: Ctx;
  };
};
