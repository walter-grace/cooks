import { MockSpeechProvider } from './mock.js';
import { OpenAiRealtimeProvider } from './openai.js';
import { SherpaSpeechProvider } from './sherpa.js';
import type { SpeechConfig, SpeechProvider } from './types.js';

export * from './types.js';
export { MockSpeechProvider } from './mock.js';
export { OpenAiRealtimeProvider } from './openai.js';
export { SherpaSpeechProvider } from './sherpa.js';

/** Build the configured recognizer, or null when the gate is off or misconfigured. */
export function speechProviderFrom(cfg: SpeechConfig | undefined): SpeechProvider | null {
  switch (cfg?.provider) {
    case 'mock':
      return new MockSpeechProvider();
    case 'openai':
      return cfg.apiKey ? new OpenAiRealtimeProvider({ apiKey: cfg.apiKey, apiBase: cfg.apiBase, model: cfg.model }) : null;
    case 'sherpa':
      return cfg.modelDir ? new SherpaSpeechProvider(cfg.modelDir) : null;
    default:
      return null;
  }
}
