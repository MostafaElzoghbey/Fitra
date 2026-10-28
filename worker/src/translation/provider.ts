// Lives in worker/src/translation/provider.ts (M0 task). Gemini and Fake
// implement it; room code depends only on this.
export type Lang = string; // BCP-47, validated against config allowlist

export interface TranslationSessionEvents {
  onAudio: (pcm24kMono: ArrayBuffer) => void;   // 24kHz PCM16LE mono chunks
  /** `text` is the full current segment so far (provider-normalized);
   * `final` marks the last emission of a turn. */
  onTranscript?: (kind: "input" | "output", text: string, final: boolean) => void;
  onStatus: (s: "connecting" | "live" | "reconnecting" | "failed", detail?: string) => void;
  onGoAway?: (timeLeftMs: number) => void;
  /** Latest SessionResumptionUpdate handle; replay it on the next open. */
  onResumption?: (handle: string) => void;
}

export interface TranslationSession {
  readonly sourceLang: Lang;
  readonly targetLang: Lang;
  sendInputAudio(pcm16kMono: ArrayBuffer): void; // 16kHz PCM16LE mono, ~100ms
  endInput(): void;   // flush buffered speech; keep session warm until idle timeout
  close(): void;
}

export interface TranslationProvider {
  readonly name: "gemini-live-translate" | "fake";
  openSession(
    sourceLang: Lang,
    targetLang: Lang,
    ev: TranslationSessionEvents,
    resumeHandle?: string,
  ): Promise<TranslationSession>;
  closeAll(): Promise<void>;
}
