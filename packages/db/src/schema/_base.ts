import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../ids.js';

/** App generates UUIDv7 (time-ordered); the DB default covers raw SQL inserts. */
export const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`).$defaultFn(uuidv7);
export const workspaceId = () => uuid('workspace_id').notNull();

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const softDelete = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

/** Standard columns for every tenant-scoped, soft-deletable resource. */
export const tenant = () => ({ id: id(), workspaceId: workspaceId(), ...timestamps, ...softDelete });
