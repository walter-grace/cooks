/**
 * Dialer provider abstraction. Twilio (human calls: bridge or softphone) and Speko (AI-voiced
 * calls) sit behind the same four verbs so the call row, polling job, UI and MCP tools do not
 * care who carries the audio.
 */
export type DialerKind = 'twilio' | 'speko';

/** Normalised result of a finished call. */
export type CallOutcome = 'answered' | 'voicemail' | 'no_answer' | 'failed';

export interface CallScript {
  /** What the voice agent should do on the call. */
  systemPrompt?: string;
  /** Opening line once the prospect picks up. */
  firstMessage?: string;
  /** BCP-47 tag such as en-US. */
  language?: string;
  voice?: string;
  /** Use a pre-built provider agent instead of an ad hoc prompt. */
  agentId?: string;
  onMachine?: 'hangup' | 'leave_message' | 'agent_decides';
  voicemailMessage?: string;
}

export interface PlaceCallInput {
  /** Cooks call row id, passed through as provider metadata. */
  callId: string;
  to: string;
  from?: string | null;
  prospectId?: string | null;
  script?: CallScript;
  maxDurationSeconds: number;
  metadata?: Record<string, unknown>;
  /** Twilio bridge mode: the rep's phone rings first. */
  repPhone?: string | null;
  /** Twilio bridge mode: where Twilio fetches TwiML and posts status. */
  callbacks?: { voiceUrl: string; statusUrl: string };
}

/** A 2xx from the provider means queued, never answered. */
export interface PlaceCallResult {
  providerCallId: string;
  status: 'queued';
  raw?: unknown;
}

export interface TranscriptEntry {
  index: number;
  role: 'agent' | 'user' | 'system';
  text: string;
  startedAt: string;
  endedAt?: string | null;
}

export interface ProviderCallState {
  status: 'queued' | 'ringing' | 'in_progress' | 'ended';
  outcome: CallOutcome | null;
  contact?: string | null;
  durationSeconds?: number | null;
  costUsd?: number | null;
  transcript?: TranscriptEntry[];
  summary?: string | null;
  endReason?: string | null;
  endedAt?: string | null;
  recordingStatus?: string | null;
  raw?: unknown;
}

export interface RecordingRef {
  url: string;
  expiresAt?: Date | null;
}

export interface DialerProvider {
  readonly kind: DialerKind;
  placeCall(input: PlaceCallInput): Promise<PlaceCallResult>;
  getCall(providerCallId: string): Promise<ProviderCallState>;
  getRecording(providerCallId: string): Promise<RecordingRef | null>;
  hangup(providerCallId: string): Promise<void>;
}

/** Provider failure with a stable code and a message safe to show a rep. Never carries credentials. */
export class DialerError extends Error {
  constructor(
    public provider: DialerKind,
    public code: string,
    message: string,
    public status: number,
    public retryable = false,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DialerError';
  }
}
