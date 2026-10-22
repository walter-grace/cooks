/** Job queue port. The worker binds pg-boss; tests bind an in-memory recorder. */
export interface JobOptions {
  startAfter?: Date;
  singletonKey?: string;
  priority?: number;
}

export type JobName =
  | 'enrollment.advance'
  | 'step.execute'
  | 'email.send'
  | 'inbox.sync'
  | 'inbound.process'
  | 'enrollment.start_pending'
  | 'mailbox.hold_release'
  | 'analytics.rollup'
  | 'outbox.publish'
  | 'webhook.deliver'
  | 'ai.draft_email'
  | 'ai.classify_reply'
  | 'ai.research'
  | 'ai.nba'
  | 'crm.sync'
  | 'crm.poll'
  | 'signals.evaluate'
  | 'signals.scan'
  | 'signals.scan_due'
  | 'telephony.recording'
  | 'telephony.ai_poll'
  | 'ai.coach_call';

export interface JobsPort {
  send(name: JobName, data: Record<string, unknown>, opts?: JobOptions): Promise<string | null>;
  cancel?(name: JobName, jobId: string): Promise<void>;
}

export class MemoryJobs implements JobsPort {
  public sent: Array<{ name: JobName; data: Record<string, unknown>; opts?: JobOptions; id: string }> = [];
  public cancelled: Array<{ name: JobName; id: string }> = [];
  private n = 0;
  async send(name: JobName, data: Record<string, unknown>, opts?: JobOptions) {
    const id = `job_${++this.n}`;
    this.sent.push({ name, data, opts, id });
    return id;
  }
  async cancel(name: JobName, jobId: string) {
    this.cancelled.push({ name, id: jobId });
  }
  clear() {
    this.sent = [];
    this.cancelled = [];
  }
}

export const noopJobs: JobsPort = { send: async () => null };
