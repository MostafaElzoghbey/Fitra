import type {
  Lang,
  TranslationProvider,
  TranslationSession,
  TranslationSessionEvents,
} from "./provider.js";

// T-015 — live Gemini provider behind env flag (TRANSLATION_PROVIDER=gemini).
// The API key lives only in a Worker secret and is used only inside the
// Durable Object -> Gemini connection. It MUST never reach the browser.
// NOTE: this module must NOT import any Gemini SDK (raw WebSocket only).
export const GEMINI_LIVE_TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";

export const GEMINI_LIVE_WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Minimal socket surface the provider needs (native WebSocket satisfies it). */
export interface GeminiSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "message" | "close" | "error" | "open",
    listener: (ev: unknown) => void,
  ): void;
  removeEventListener(
    type: "message" | "close" | "error" | "open",
    listener: (ev: unknown) => void,
  ): void;
}

export interface GeminiProviderOptions {
  /** Override the WSS endpoint (tests / future regions). */
  endpoint?: string;
  /** Inject a socket factory (tests use a fake; default = global WebSocket). */
  createSocket?: (url: string) => GeminiSocket;
  /** Resume a previous session (SessionResumptionUpdate handle). */
  resumeHandle?: string;
}

export interface GeminiSetupOptions {
  /** OQ-01 tolerant client: "toplevel" first (T-014 probe winner), retrying the
   * other placement once on close or 15 s handshake timeout. */
  placement?: "documented" | "toplevel";
}

/** Build the setup message. Isolated so the T-014 probe can flip placement
 * in one line. echoTargetLanguage is always false (same-language input never
 * opens a session anyway — OQ-07 decision). */
export function buildGeminiSetup(
  targetLang: Lang,
  opts: GeminiSetupOptions = {},
): Record<string, unknown> {
  const placement = opts.placement ?? "documented";
  const transcriptions = { inputAudioTranscription: {}, outputAudioTranscription: {} };
  return {
    setup: {
      model: `models/${GEMINI_LIVE_TRANSLATE_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: { targetLanguageCode: targetLang, echoTargetLanguage: false },
        ...(placement === "documented" ? transcriptions : {}),
      },
      ...(placement === "toplevel" ? transcriptions : {}),
      sessionResumption: {},
      contextWindowCompression: {
        triggerTokens: 20000,
        slidingWindow: { targetTokens: 8000 },
      },
    },
  };
}

/** Encode ~100 ms of 16 kHz PCM16LE mono as a realtimeInput audio message.
 * Isolated (OQ-02 decision): if the probe finds a different envelope, only
 * this function changes. */
export function encodeGeminiAudioFrame(pcm16kMono: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(pcm16kMono);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return JSON.stringify({
    realtimeInput: { audio: { data: btoa(binary), mimeType: "audio/pcm;rate=16000" } },
  });
}

type AudioHandler = (pcm24kMono: ArrayBuffer) => void;

function base64ToBytes(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/** Parse one server text frame. Returns "audio" payloads via onAudio and
 * reports lifecycle signals. Unknown shapes are ignored (preview API drift). */
export function handleGeminiServerText(
  text: string,
  sink: {
    onAudio: AudioHandler;
    onTranscript?: (kind: "input" | "output", text: string) => void;
    onSetupComplete: () => void;
    onGoAway?: (timeLeftMs: number) => void;
    onResumption?: (handle: string) => void;
  },
): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if ("setupComplete" in msg) {
    sink.onSetupComplete();
    return;
  }
  if (typeof msg["goAway"] === "object" && msg["goAway"] !== null) {
    const timeLeft = (msg["goAway"] as { timeLeft?: string }).timeLeft;
    const ms = typeof timeLeft === "string" && timeLeft.endsWith("s")
      ? Math.round(Number.parseFloat(timeLeft) * 1000)
      : 60000;
    sink.onGoAway?.(Number.isFinite(ms) ? ms : 60000);
    return;
  }
  if (typeof msg["sessionResumptionUpdate"] === "object" && msg["sessionResumptionUpdate"] !== null) {
    const u = msg["sessionResumptionUpdate"] as { newHandle?: string; resumable?: boolean };
    if (u.resumable === true && typeof u.newHandle === "string" && u.newHandle !== "") {
      sink.onResumption?.(u.newHandle);
    }
    return;
  }
  const content = msg["serverContent"] as
    | { modelTurn?: { parts?: { inlineData?: { data?: string } }[] }; inputTranscription?: { text?: string }; outputTranscription?: { text?: string } }
    | undefined;
  if (typeof content !== "object" || content === null) return;
  const parts = content.modelTurn?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (typeof data === "string" && data !== "") sink.onAudio(base64ToBytes(data));
  }
  if (typeof content.inputTranscription?.text === "string" && content.inputTranscription.text !== "") {
    sink.onTranscript?.("input", content.inputTranscription.text);
  }
  if (typeof content.outputTranscription?.text === "string" && content.outputTranscription.text !== "") {
    sink.onTranscript?.("output", content.outputTranscription.text);
  }
}

type SetupPlacement = "documented" | "toplevel";

class GeminiTranslationSession implements TranslationSession {
  private socket: GeminiSocket | null = null;
  private dead = false;
  private settled = false;
  private generation = 0;

  constructor(
    readonly sourceLang: Lang,
    readonly targetLang: Lang,
    private readonly apiKey: string,
    private readonly opts: GeminiProviderOptions,
    private readonly ev: TranslationSessionEvents,
  ) {}

  async open(): Promise<void> {
    // Probe winner (T-014, 2026-10-15): top-level transcription fields reach
    // setupComplete; the documented generationConfig placement hangs with no
    // response at all (not even a 1007). Toplevel first, documented as fallback.
    this.connect("toplevel", false);
  }

  private connect(placement: SetupPlacement, retried: boolean): void {
    if (this.dead) return;
    this.generation += 1;
    const generation = this.generation;
    this.ev.onStatus("connecting");
    const endpoint = this.opts.endpoint ?? GEMINI_LIVE_WS_ENDPOINT;
    const url =
      `${endpoint}?key=${encodeURIComponent(this.apiKey)}` +
      (this.opts.resumeHandle ? `&resume=${encodeURIComponent(this.opts.resumeHandle)}` : "");
    const create =
      this.opts.createSocket ??
      ((u: string): GeminiSocket => new WebSocket(u) as unknown as GeminiSocket);
    const socket = create(url);
    // Drop a previous socket (1007-placement retry path).
    try {
      this.socket?.close();
    } catch {
      // Ignore close errors during retry.
    }
    this.socket = socket;

    const handleText = (text: string): void => {
      handleGeminiServerText(text, {
        onAudio: (buf) => {
          if (!this.dead) this.ev.onAudio(buf);
        },
        onTranscript: this.ev.onTranscript,
        onSetupComplete: () => {
          if (!this.settled) {
            this.settled = true;
            this.ev.onStatus("live");
          }
        },
        onGoAway: (ms) => this.ev.onGoAway?.(ms),
        onResumption: () => undefined,
      });
    };
    const onMessage = (raw: unknown): void => {
      if (generation !== this.generation) return;
      const data = (raw as { data?: unknown }).data;
      // T-017: Gemini wraps JSON control frames in binary WS frames — decode,
      // don't drop. (setupComplete arrived as a Blob; ignoring non-string
      // frames caused a permanent connecting loop in production.)
      if (typeof data === "string") {
        handleText(data);
        return;
      }
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        handleText(new TextDecoder().decode(data as ArrayBuffer));
        return;
      }
      const asBlob = data as { arrayBuffer?: unknown };
      if (data !== null && typeof data === "object" && typeof asBlob.arrayBuffer === "function") {
        (asBlob.arrayBuffer as () => Promise<ArrayBuffer>)().then(
          (buf) => {
            if (!this.dead && generation === this.generation) {
              handleText(new TextDecoder().decode(buf));
            }
          },
          () => undefined,
        );
      }
    };
    const onClose = (raw: unknown): void => {
      if (this.dead || generation !== this.generation) return;
      const code = (raw as { code?: unknown }).code;
      if (!this.settled && !retried) {
        this.ev.onStatus("reconnecting", "retry-other-placement");
        this.connect(placement === "toplevel" ? "documented" : "toplevel", true);
        return;
      }
      this.ev.onStatus("reconnecting", `gemini-close code=${String(code)}`);
    };
    const onError = (): void => {
      if (this.dead || generation !== this.generation || !this.settled) return;
      this.ev.onStatus("reconnecting", "gemini-socket-error");
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    // Browsers and workerd both reject send() before the socket opens, so the
    // setup frame must wait for "open" — sending it eagerly caused a silent
    // setup-send-failed loop in production (T-017).
    const onOpen = (): void => {
      if (this.dead || generation !== this.generation) return;
      try {
        socket.send(JSON.stringify(buildGeminiSetup(this.targetLang, { placement })));
      } catch {
        console.log("[gemini-diag] setup send threw");
        this.ev.onStatus("reconnecting", "gemini-setup-send-failed");
      }
    };
    socket.addEventListener("open", onOpen);
    // The documented placement hangs with no response at all (T-014 P1), so a
    // close code alone cannot drive the fallback — watchdog the handshake.
    setTimeout(() => {
      if (this.dead || generation !== this.generation || this.settled) return;
      if (!retried) {
        this.ev.onStatus("reconnecting", "retry-other-placement");
        this.connect(placement === "toplevel" ? "documented" : "toplevel", true);
        return;
      }
      this.ev.onStatus("reconnecting", "gemini-setup-timeout");
    }, 15000);
  }

  sendInputAudio(pcm16kMono: ArrayBuffer): void {
    if (this.dead) return;
    try {
      this.socket?.send(encodeGeminiAudioFrame(pcm16kMono));
    } catch {
      this.ev.onStatus("reconnecting", "gemini-send-failed");
    }
  }

  endInput(): void {
    // Translation is streaming; nothing to flush. Session stays warm.
  }

  close(): void {
    this.dead = true;
    this.generation += 1;
    try {
      this.socket?.close();
    } catch {
      // Ignore close errors.
    }
    this.socket = null;
  }
}

export class GeminiTranslationProvider implements TranslationProvider {
  readonly name = "gemini-live-translate" as const;
  private readonly sessions = new Set<GeminiTranslationSession>();

  constructor(
    private readonly apiKey: string,
    private readonly opts: GeminiProviderOptions = {},
  ) {
    if (apiKey === "") throw new Error("gemini: API key must not be empty");
  }

  async openSession(
    sourceLang: Lang,
    targetLang: Lang,
    ev: TranslationSessionEvents,
  ): Promise<TranslationSession> {
    const session = new GeminiTranslationSession(sourceLang, targetLang, this.apiKey, this.opts, ev);
    this.sessions.add(session);
    await session.open();
    return session;
  }

  async closeAll(): Promise<void> {
    for (const s of this.sessions) s.close();
    this.sessions.clear();
  }
}
