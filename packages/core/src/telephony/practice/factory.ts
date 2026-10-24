import { LocalVoicePartner } from './local.js';
import { MockVoicePartner } from './mock.js';
import { OpenAiVoicePartner } from './openai.js';
import type { PracticeConfig, VoicePartner } from './types.js';

export const PRACTICE_MAX_SECONDS_DEFAULT = 600;

/** Build the configured partner, or null when practice is off or misconfigured. */
export function voicePartnerFrom(cfg: PracticeConfig | undefined): VoicePartner | null {
  switch (cfg?.provider) {
    case 'mock':
      return new MockVoicePartner();
    case 'openai':
      return cfg.apiKey ? new OpenAiVoicePartner({ apiKey: cfg.apiKey, apiBase: cfg.apiBase, model: cfg.model, voice: cfg.voice }) : null;
    case 'local':
      return cfg.localUrl ? new LocalVoicePartner(cfg.localUrl) : null;
    default:
      return null;
  }
}

/** What the UI shows before a call: which partner is wired up, if any. */
export function practiceStatus(cfg: PracticeConfig | undefined) {
  const partner = voicePartnerFrom(cfg);
  const provider = cfg?.provider ?? 'off';
  return {
    configured: !!partner,
    provider,
    reason: partner ? null : provider === 'off' ? 'Practice is off. Set PRACTICE_PROVIDER on the server.' : provider === 'openai' ? 'PRACTICE_PROVIDER=openai needs PRACTICE_API_KEY or OPENAI_API_KEY.' : provider === 'local' ? 'PRACTICE_PROVIDER=local needs PRACTICE_LOCAL_URL.' : 'Partner is not available.',
    voice: cfg?.voice ?? null,
    maxSeconds: cfg?.maxSeconds ?? PRACTICE_MAX_SECONDS_DEFAULT,
  };
}
