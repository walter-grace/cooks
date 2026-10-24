/**
 * Local streaming recognition with sherpa-onnx (Apache-2.0) and an NVIDIA streaming transducer
 * such as Nemotron Speech (80 ms chunks) or a Zipformer. Nothing leaves the box. `sherpa-onnx-node`
 * is an optional native dependency loaded at runtime; without it this provider refuses to open.
 * Model dir layout (sherpa release tarballs): encoder*.onnx, decoder*.onnx, joiner*.onnx, tokens.txt.
 * Written from the package's JS API (streaming-asr.js); not yet run against a downloaded model here.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resampleToFloat32 } from '../audio.js';
import { BaseSpeechStream, type SpeechProvider } from './types.js';

interface SherpaOnlineStream {
  acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}
interface SherpaOnlineRecognizer {
  createStream(): SherpaOnlineStream;
  isReady(s: SherpaOnlineStream): boolean;
  decode(s: SherpaOnlineStream): void;
  isEndpoint(s: SherpaOnlineStream): boolean;
  reset(s: SherpaOnlineStream): void;
  getResult(s: SherpaOnlineStream): { text: string };
}
interface SherpaModule {
  OnlineRecognizer: new (config: Record<string, unknown>) => SherpaOnlineRecognizer;
}

const RATE = 16_000;

export class SherpaSpeechProvider implements SpeechProvider {
  readonly kind = 'sherpa' as const;
  private recognizer: SherpaOnlineRecognizer | null = null;
  private loading: Promise<SherpaOnlineRecognizer> | null = null;
  constructor(private readonly modelDir: string, private readonly numThreads = 1) {}

  /** Load the native addon and model once; rejects when sherpa-onnx-node is not installed. */
  load(): Promise<SherpaOnlineRecognizer> {
    if (this.recognizer) return Promise.resolve(this.recognizer);
    this.loading ??= (async () => {
      const modName = 'sherpa-onnx-node';
      const mod = (await import(modName)) as SherpaModule;
      const files = readdirSync(this.modelDir);
      const pick = (re: RegExp) => {
        const f = files.find((x) => re.test(x));
        if (!f) throw new Error(`speech: no ${re} in ${this.modelDir}`);
        return join(this.modelDir, f);
      };
      const nemo = /nemo|nemotron|parakeet/i.test(this.modelDir);
      this.recognizer = new mod.OnlineRecognizer({
        featConfig: { sampleRate: RATE, featureDim: 80 },
        modelConfig: { transducer: { encoder: pick(/^encoder.*\.onnx$/), decoder: pick(/^decoder.*\.onnx$/), joiner: pick(/^joiner.*\.onnx$/) }, tokens: pick(/^tokens\.txt$/), numThreads: this.numThreads, provider: 'cpu', debug: 0, ...(nemo ? { modelType: 'nemo_transducer' } : {}) },
        decodingMethod: 'greedy_search',
        maxActivePaths: 4,
        enableEndpoint: true,
        rule1MinTrailingSilence: 1.2,
        rule2MinTrailingSilence: 0.5,
        rule3MinUtteranceLength: 12,
      });
      return this.recognizer;
    })();
    return this.loading;
  }

  open() {
    const s = new SherpaStream(this);
    return s;
  }
}

class SherpaStream extends BaseSpeechStream {
  private rec: SherpaOnlineRecognizer | null = null;
  private stream: SherpaOnlineStream | null = null;
  private backlog: Float32Array[] = [];
  private last = '';
  constructor(p: SherpaSpeechProvider) {
    super();
    p.load()
      .then((rec) => {
        if (this.closed) return;
        this.rec = rec;
        this.stream = rec.createStream();
        for (const b of this.backlog) this.feed(b);
        this.backlog = [];
      })
      .catch((e: unknown) => this.fail(e instanceof Error ? e : new Error(String(e))));
  }
  private feed(samples: Float32Array) {
    if (!this.rec || !this.stream) return;
    this.stream.acceptWaveform({ samples, sampleRate: RATE });
    while (this.rec.isReady(this.stream)) this.rec.decode(this.stream);
    const text = this.rec.getResult(this.stream).text.trim();
    const endpoint = this.rec.isEndpoint(this.stream);
    if (text && (text !== this.last || endpoint)) this.emit({ text, final: endpoint });
    this.last = endpoint ? '' : text;
    if (endpoint) this.rec.reset(this.stream);
  }
  push(frame: Int16Array, sampleRate: number) {
    if (this.closed) return;
    const f = resampleToFloat32(frame, sampleRate, RATE);
    if (this.rec) this.feed(f);
    else if (this.backlog.length < 400) this.backlog.push(f);
  }
  override close() {
    super.close();
    this.stream = null;
  }
}
