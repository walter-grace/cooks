/**
 * Decide "person or machine" from the first second or two of a pickup. Carrier AMD waits for
 * ~2.4 s of speech and then a pause; a person saying "Hello?" is done talking in 600 ms. With the
 * words in hand we can call it as soon as the greeting ends, or the instant we hear "you've
 * reached". Rules first (free, sub-millisecond); an optional decision model breaks ties.
 */
import type { VadTimeline } from './vad.js';

export type Verdict = 'human' | 'machine' | 'unknown';

export interface Evidence extends VadTimeline {
  /** Recognizer text so far, lower-cased by the judge. */
  text: string;
  /** True when the recognizer marked the current utterance final. */
  final: boolean;
}

export interface Judgement {
  verdict: Verdict;
  /** Stable code for the rule that fired, for logs and tests. */
  reason: string;
  /** 0..1 */
  confidence: number;
}

export interface JudgeOptions {
  /** A greeting this short, followed by `greetingSilenceMs` of silence, is a person (ms). */
  greetingMaxMs?: number;
  greetingSilenceMs?: number;
  /** Continuous speech this long with no pause is a recording (ms). */
  monologueMs?: number;
  /** Give up and defer to AMD after this much audio (ms). */
  maxMs?: number;
}

export const JUDGE_DEFAULTS: Required<JudgeOptions> = { greetingMaxMs: 1800, greetingSilenceMs: 350, monologueMs: 2600, maxMs: 6000 };

/** Phrases that only recordings say. Checked as substrings of the lower-cased transcript. */
export const MACHINE_PHRASES = [
  "you've reached", 'you have reached', "you've called", 'you have called', 'reached the voicemail', 'reached the voice mail',
  'not available', 'unavailable', "can't take your call", 'cannot take your call', 'unable to take your call', 'unable to answer',
  "can't come to the phone", 'cannot come to the phone', 'away from my phone', 'away from the phone', 'not able to answer',
  'leave a message', 'leave your name', 'leave me a message', 'leave your message', 'record your message', 'after the tone', 'at the tone', 'after the beep', 'at the beep',
  'mailbox', 'voicemail', 'voice mail', 'google voice', 'the subscriber', 'the person you are calling', 'the person you are trying to reach', 'the number you have dialed', 'the number you dialed',
  'is not in service', 'has been disconnected', 'press one', 'press 1', 'press two', 'press 2', 'press zero', 'press 0', 'to leave a', 'for more options', 'please hold', 'your call is important',
  'thank you for calling', 'thanks for calling', 'office hours', 'business hours', 'our offices are', 'if you know your party', 'dial by name', 'directory',
];

/** Phrases a person answering says. Short, conversational, often a question. */
export const HUMAN_PHRASES = ['hello', 'hi', 'hey', 'yes', 'yeah', 'yep', 'yo', 'this is', 'speaking', 'go ahead', 'who is this', "who's this", 'how can i help', 'can i help you', 'good morning', 'good afternoon', 'good evening', 'how are you', "what's up", 'sup', 'talk to me', 'hola', 'hallo', 'bonjour', 'allo'];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string) => (s ? s.split(' ').filter(Boolean) : []);

/** Text-only classification; `null` when the words do not settle it. */
export function judgeText(raw: string): Judgement | null {
  const text = norm(raw);
  if (!text) return null;
  const machine = MACHINE_PHRASES.find((p) => text.includes(p));
  if (machine) return { verdict: 'machine', reason: `phrase:${machine}`, confidence: 0.95 };
  const n = words(text).length;
  if (n <= 6 && HUMAN_PHRASES.some((p) => text === p || text.startsWith(`${p} `) || text.endsWith(` ${p}`) || text.includes(` ${p} `))) return { verdict: 'human', reason: 'greeting', confidence: n <= 3 ? 0.9 : 0.8 };
  // "Dana Lee." / "Acme, this is Dana." style pickups: a short phrase that is not a recording.
  if (n >= 1 && n <= 4) return { verdict: 'human', reason: 'short_pickup', confidence: 0.6 };
  return null;
}

/**
 * Combine timing and words. Returns null to keep listening. Confidence below 0.75 is what the
 * optional decision model is for; callers may treat `short_pickup` as "ask Jev".
 */
export function judgeAnswer(e: Evidence, o: JudgeOptions = {}): Judgement | null {
  const c = { ...JUDGE_DEFAULTS, ...o };
  if (e.beep) return { verdict: 'machine', reason: 'beep', confidence: 0.97 };
  const byText = judgeText(e.text);
  if (byText?.verdict === 'machine') return byText;
  // A recording talks straight through; people stop after a few words and wait for you.
  if (e.longestRunMs >= c.monologueMs) return { verdict: 'machine', reason: 'monologue', confidence: 0.85 };
  if (e.firstSpeechMs !== null && e.runMs === 0 && (e.silenceAfterSpeechMs ?? 0) >= c.greetingSilenceMs && e.longestRunMs <= c.greetingMaxMs) {
    // A recognised greeting plus the pause is as sure as this gets; a bare name or company stays
    // low-confidence so the gate can put it to Jev when configured.
    if (byText?.verdict === 'human') return { verdict: 'human', reason: byText.reason, confidence: byText.reason === 'greeting' ? Math.max(byText.confidence, 0.85) : byText.confidence };
    // Spoke briefly, then went quiet, but the recognizer heard nothing usable: timing alone says person.
    if (!e.text.trim() && e.speechMs >= 150) return { verdict: 'human', reason: 'brief_then_quiet', confidence: 0.7 };
    if (e.text.trim()) return { verdict: 'human', reason: 'brief_then_quiet', confidence: 0.75 };
  }
  // The recognizer closed an utterance that reads like a greeting: do not wait for the silence rule.
  if (e.final && byText?.verdict === 'human' && byText.confidence >= 0.8 && e.longestRunMs <= c.greetingMaxMs) return { verdict: 'human', reason: `${byText.reason}:final`, confidence: byText.confidence };
  if (e.elapsedMs >= c.maxMs) return { verdict: 'unknown', reason: 'timeout', confidence: 0 };
  return null;
}
