/**
 * Dialer provider abstraction. Twilio (human calls: bridge or softphone), Speko and Dial (AI-voiced
 * calls) sit behind the same four verbs so the call row, polling job, UI and MCP tools do not
 * care who carries the audio.
 */
export type DialerKind = 'twilio' | 'speko' | 'dial';

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

/* ------------------------------------------------------------ parallel dialing */

/** Where the carrier posts events for one prospect leg. */
export interface LegCallbacks {
  /** TwiML/instructions fetched when the callee answers (we hold in silence while AMD runs). */
  voiceUrl: string;
  /** Call progress: initiated, ringing, answered, completed. */
  statusUrl: string;
  /** Asynchronous answering-machine verdict. */
  amdUrl: string;
}

export interface DialLegInput {
  lineId: string;
  to: string;
  from: string;
  ringTimeoutSeconds: number;
  callbacks: LegCallbacks;
  /** Carrier-specific AMD tuning; Twilio uses `AmdOptions`. */
  amd: Record<string, unknown>;
}

export interface RepLegInput {
  to: string;
  from: string;
  conference: string;
  callbacks: { voiceUrl: string; statusUrl: string };
}

/**
 * What a carrier must do for first-human-wins parallel dialing. The engine in
 * `telephony/parallel.ts` owns the state machine and the atomic winner claim; the carrier
 * only moves audio. Add Telnyx, SignalWire or Jambonz by implementing this.
 */
export interface ParallelCarrier {
  readonly kind: DialerKind;
  /** Ring the rep's phone and, when answered, drop them into the conference (phone fallback). */
  dialRep(i: RepLegInput): Promise<{ providerCallId: string }>;
  /** Dial one prospect with async AMD. Resolves when the carrier accepts the request, never when answered. */
  dialProspect(i: DialLegInput): Promise<{ providerCallId: string }>;
  /** Move an answered prospect leg into the conference with no beep or announcement. */
  joinConference(providerCallId: string, conference: string, opts: { statusCallback?: string; label?: string }): Promise<void>;
  /** End a leg whether it is still ringing or already answered. Must be idempotent. */
  hangupLeg(providerCallId: string, phase: 'ringing' | 'answered' | 'unknown'): Promise<void>;
  /** Play a short message to an answered leg, then hang up (consumer-mode abandoned-call notice). */
  sayAndHangup(providerCallId: string, message: string): Promise<void>;
  /** Record the rep's leg (dual channel) from now; returns the recording id. */
  startRecording(repCallId: string, statusCallback: string): Promise<string | null>;
  stopRecording(repCallId: string, recordingId: string | null): Promise<void>;
  /** Tear the room down (ends every participant). */
  endConference(conferenceId: string): Promise<void>;
  /** Instructions for a rep leg that just answered (phone or browser): join the room and wait in silence. */
  repJoinDocument(conference: string, opts: { statusCallback: string; label: string }): string;
  /** Instructions for a prospect leg that just answered: hold silently while AMD decides, optionally forking its audio to the speech gate. */
  prospectHoldDocument(seconds: number, stream?: { url: string; params: Record<string, string> }): string;
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
