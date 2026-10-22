/** The 24 upstream scopes plus Cooks extensions. */
export const UPSTREAM_SCOPES = [
  'prospects:read',
  'prospects:write',
  'sequences:read',
  'sequences:write',
  'sequence-steps:read',
  'sequence-steps:write',
  'sequence-states:read',
  'sequence-states:write',
  'tasks:read',
  'tasks:write',
  'calls:read',
  'calls:write',
  'emails:read',
  'emails:write',
  'tags:read',
  'tags:write',
  'call-dispositions:read',
  'email-templates:read',
  'mailboxes:read',
  'users:read',
  'accounts:read',
  'opportunities:read',
  'search:read',
  'notes:write',
] as const;

export const EXTENSION_SCOPES = ['webhooks:write', 'api-keys:write', 'agents:run', 'emails:send'] as const;

export const SCOPES = [...UPSTREAM_SCOPES, ...EXTENSION_SCOPES] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'prospects:read': 'View prospects',
  'prospects:write': 'Create and update prospects',
  'sequences:read': 'View sequences',
  'sequences:write': 'Create and update sequences',
  'sequence-steps:read': 'View sequence steps',
  'sequence-steps:write': 'Create, edit, delete and reorder sequence steps',
  'sequence-states:read': 'View sequence enrollments',
  'sequence-states:write': 'Enroll, pause and finish prospects in sequences',
  'tasks:read': 'View tasks',
  'tasks:write': 'Create, update, complete and skip tasks',
  'calls:read': 'View calls',
  'calls:write': 'Log calls',
  'emails:read': 'View emails',
  'emails:write': 'Create email drafts and send emails',
  'tags:read': 'View tags',
  'tags:write': 'Create tags',
  'call-dispositions:read': 'View call dispositions',
  'email-templates:read': 'View email templates',
  'mailboxes:read': 'View mailboxes',
  'users:read': 'View workspace users',
  'accounts:read': 'View accounts',
  'opportunities:read': 'View opportunities',
  'search:read': 'Search prospects and accounts',
  'notes:write': 'Create notes',
  'webhooks:write': 'Manage webhook endpoints',
  'api-keys:write': 'Manage API keys',
  'agents:run': 'Run hosted agents',
  'emails:send': 'Send emails through connected mailboxes',
};

export function isScope(s: string): s is Scope {
  return (SCOPES as readonly string[]).includes(s);
}
