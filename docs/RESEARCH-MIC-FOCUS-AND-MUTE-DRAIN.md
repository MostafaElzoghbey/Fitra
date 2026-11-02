# تقرير بحثي: تركيز الصوت على المتحدث — وسلوك الكتم والترجمة المعلّقة

> **حالة التقرير:** بحث فقط (لا يوجد تنفيذ). أُعد بتاريخ 2026-11-01 بعد فحص كامل لخط الصوت في الكود + بحث خارجي في الوثائق والمصادر (2025–2026).
>
> **المشكلتان قيد البحث:**
> - **المشكلة (A):** الميكروفون يلتقط جميع الأصوات المحيطة بالمتحدث، مما يؤثر على جودة الترجمة. المطلوب: التركيز على صوت المتحدث كما تفعل التطبيقات الحديثة.
> - **المشكلة (B):** عندما يتحدث المتحدث طويلًا ثم يغلق الميكروفون، ينقطع الصوت المترجم عند المستمع قبل اكتماله، وعند فتح الميكروفون من جديد يُستأنف إرسال ترجمة الكلام القديم. المطلوب: بعد الغلق يستمر تفريغ (Drain) كل ما قيل قبل الغلق حتى نهايته، وبعد الفتح لا يُنقل إلا الكلام الجديد فقط.

---

## الجزء الأول: المشكلة (A) — التقاط الضوضاء المحيطة

### 1. ما يحدث حاليًا في الكود (جذور المشكلة)

#### 1.1 قيود الميكروفون طُلبت لكنها ليست مضمونة

`web/src/audio/devices.ts:56-70` — `micConstraints()`:

```ts
return {
  ...(deviceId === undefined || deviceId === "" ? {} : { deviceId: { exact: deviceId } }),
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: { ideal: idealSampleRateHz }, // 16000
};
```

الأعلام الثلاثة (`echoCancellation`, `noiseSuppression`, `autoGainControl`) مطلوبة كقيم `true`، لكنها **قيد على المستوى المفضّل (ideal) وليست ضمانًا** — المتصفح قد يتجاهلها. الكود يتحقق بعدها فقط عبر `track.getSettings()` (`devices.ts:98-105`)، وعند عدم تطبيق أيٍّ منها يفعل `MicCapture.reportProcessing` (`capture.ts:502-512`) شيئًا واحدًا:

```ts
console.warn("[fitra] echo cancellation / noise suppression / AGC not all applied");
```

**التطبيق يستمر رغم ذلك** — لا إشعار للمستخدم، ولا محاولة إعادة، ولا مسار بديل. على البيئات التي لا يطبّق فيها المتصفح المعالجة (شائع في Linux/PulseAudio، بعض أجهزة Android WebView، وبعض ميكروفونات USB) يُبثّ الصوت الخام بحساسية كاملة إلى Gemini.

#### 1.2 حتى مع وجود معالجة المتصفح: AGC يضخّم الضوضاء أثناء الصمت

`autoGainControl: true` يرفع الكسب تلقائيًا أثناء صمت المتحدث لمجاربة مستوى الكلام المستهدف — وهذا سبب كلاسيكي لـ"التقاط كل الأصوات المحيطة": الضوضاء الخافتة تُضخَّم حتى تبلغ مستوى الكلام ثم تُرسل للمترجم.

#### 1.3 كل إطار صوت — حتى الصامت أو المشوش — يُرسل: لا VAD ولا Noise Gate

- البنية الحالية (`capture.ts:358-404`): `AudioContext` بمعدل 16 kHz ← `MediaStreamSource` ← `AudioWorkletNode` (`fitra-capture`).
- الوركتلت (`web/public/worklets/capture.worklet.js:141-152`) يجمّع كل 1600 عينة (100ms) ويحوّلها PCM16LE ويبعث إطارًا كل 100ms — **بلا أي شرط على المحتوى**: أي إطار صمت أو ضوضاء يُرسل إلى الخادم ثم إلى Gemini.
- لا يوجد أي فلتر تمرير عالٍ (High-pass)، ولا بوابة ضوضاء، ولا كشف نشاط صوتي (VAD) في أي موضع في المسار عميلًا أو خادمًا.

#### 1.4 آلية الكتم تبقي عتاد الميكروفون مفتوحًا

`roomShell.ts:138-153`:

```ts
function stopSource(): void {
  injector?.stop();
  if (mic !== null) sender.setSocket(null); // هذه هي آلية الكتم كاملة
}
```

الكتم = فصل السوكت عن المرسل فقط. ليس `track.enabled=false`، وليس `track.stop()`، وليس `AudioContext.suspend()`. النتائج:
- **مؤشر الميكروفون في المتصفح يبقى مضاءً أثناء "الكتم"** (العتاد مفتوح).
- الوركتلت يستمر بإنتاج إطارات يُسقطها المرسل فورًا (`capture.ts:255-261`).

#### 1.5 لا يوجد تحكم للمستخدم في المعالجة

لا توجد أي واجهة لتشغيل/إيقاف `noiseSuppression` أو AGC؛ القيم مضمّنة (hardcoded).

### 2. كيف تعالجها التطبيقات الحديثة (نتائج البحث الخارجي)

| التطبيق | الأسلوب |
|---|---|
| **MS Teams "Voice Focus"** | مزيل ضوضاء ML على مستوى النظام (Windows Voice Clarity / macOS Voice Isolation). غير متاح كقيد ويب؛ Teams على الويب يعود إلى WebRTC APM. |
| **Google Meet "Improved noise cancellation"** | مزيل ضوضاء ML مدمج في Chromium (`VoiceIsolationHandler` + `MlModelType::kVoiceIsolationDenoiser`)، مفعّل عبر راية `MediaCaptureVoiceIsolation` Finch وقيد W3C `voiceIsolation`. |
| **Krisp** | شبكة عصبية WASM (إطارات 10ms) داخل AudioWorklet + Worker. ميزتان: NC (ضوضاء خلفية) و**BVC (إلغاء الأصوات/الكلام الخلفي — "تركيز حقيقي على متحدث واحد")**. الحزمة ~12MB، ذاكرة ~100MB، تكلفة إطار 1.5–2ms. **رخصة تجارية**. |
| **Jitsi Meet** | `@jitsi/rnnoise-wasm` داخل AudioWorklet (`NoiseSuppressorWorklet`) — مفتوح المصدر. |
| **LiveKit** | فلتر Krisp على الواجهة + معالجة على الخادم عبر LiveKit Cloud؛ تحذير رسمي: **لا تكدّس نموذجين محسّنين على نفس المسار**. |

### 3. الخيارات المتاحة لـ Fitra (مرتبة)

#### الخيار 1 — القيود الأصلية + `voiceIsolation` (الأدنى جهدًا)

الإبقاء على `EC/NS/AGC=true`، وإضافة `voiceIsolation: true` بعد فحص الدعم:

```js
const supported = navigator.mediaDevices.getSupportedConstraints().voiceIsolation;
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { voiceIsolation: true, noiseSuppression: true },
});
```

**حالة قيد `voiceIsolation` حتى 2026:** أُطلق في Chrome M123 **على ChromeOS فقط** (مجموعة أجهزة فرعية). تُراجع Chrome (Chromium) **تعطّل القيد صراحة على كل المنصات غير ChromeOS** (Bug 502167908). على Windows/Mac يفعّل Chromium معالجة النظام (Windows 11 24H2 "Voice Clarity") عبر راية مستخدم (`media::kEnforceSystemEchoCancellation`) — **لا يستطيع تطبيق ويب فرضها عبر JS**. Firefox/Safari: لا إشارة دعم (WebKit standards-positions#314).

**الحكم:** استخدِمها كتلميح بعد كشف الميزات؛ **لا توثّق عليها** لميدان عربي في MVP.

جديد في Chrome 141: خيار `echoCancellation: "all" | "remote-only"` — يتيح اختيار ما إذا كان يُلغى صدا كل مخرجات النظام أم مخرجات PeerConnection فقط (مفيد عندما يشغّل المعلم وسائط). المراجع: [Chrome 141 release notes](https://developer.chrome.com/release-notes/141)، [Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/x5nfoaUAUWY).

#### الخيار 2 — معالجة رقمية على العميل: RNNoise / GTCRN + Silero VAD (الموصى به)

| المكتبة | النموذج | الإطار | التكلفة (قيَم مقاسة) | الرخصة | ملاحظات |
|---|---|---|---|---|---|
| **`@sapphi-red/web-noise-suppressor`** | RNNoise، SpeexDSP، **GTCRN** | 480 @48k (RNNoise) | أقل من 1ms/إطار | MIT | حزمة npm واحدة بأربع عقد AudioWorklet. **GTCRN مزيل ضوضاء عصبي (Xiaobin-Rong/gtcrn) — أقرب جودة مفتوحة إلى Meet**. مستخدمة في [sokuji](https://github.com/kizuna-ai-lab/sokuji). |
| **`@jitsi/rnnoise-wasm`** | RNNoise (xiph) | 480 @48k | ~0.5–1ms | Apache-2.0 | مثبت إنتاجيًا في Jitsi. |
| **`@ricky0123/vad-web` (Silero VAD)** | Silero v5/v6 ONNX | 512 @16k (32ms) | أقل من 1ms CPU/إطار؛ 131× RTF على WebGPU | MIT | نموذج ~2MB. **هو كاشف نشاط (VAD) وليس مزيل ضوضاء** — يُقرَن مع أحدهما. يعطي `SpeechStart`/`SpeechEnd` مع تحوّل داخل/خارج (hysteresis). |
| WebRTC VAD (libfvad WASM) | GMM، 6 نطاقات | 10/20/30ms | 0.008–0.012ms | BSD | الأرخص؛ ضعيف في الغرف المزعجة. |
| Krisp JS SDK | NC + BVC عصبي | 10ms | 1.5–2ms/إطار؛ ~100MB RAM | **تجارية** | الأعلى جودة، لكن رخصة + حمولة 12MB. |

#### الخيار 3 — مزيل ضوضاء على الخادم (داخل DO قبل Gemini)

- SpeexDSP WASM (إعادة معدل العينات/preprocess) — نمط مثبت في مرجع Cloudflare [`ai-tts-stt`](https://github.com/cloudflare/realtime-examples/blob/main/ai-tts-stt/src/stt-adapter.ts).
- RNNoise WASM داخل DO بمكلفة ~0.5–1ms/إطار — لكن Workers تتطلب `[[rules]] type = "CompiledWasm"` و`instantiateWasm` (نمط مثبت في [silero-vad discussion #760](https://github.com/snakers4/silero-vad/discussions/760)).
- **المقايضة:** المعالجة على العميل توفّر استهلاك مسار الرفع وتمنح Gemini صوتًا أنظف؛ على الخادم تخفي CPU من العميل ضعيف الأجهزة (Chromebook) لكنها تضيف زمن لـ DO (فوترة) + 5–15ms زمن صعود إضافي.

### 4. توصية المشكلة (A) — خط معالجة عملي

```
Mic (getUserMedia: EC=true, NS=true, AGC=true, voiceIsolation=true إن كان مدعومًا)
  → AudioWorklet: High-pass + بوابة ضوضاء (رخيصة)
  → AudioWorklet: Silero VAD (512@16k) — يرصد ما يُرسل فعليًا ويقدم زمنيًا بداية/نهاية الكلام
  → AudioWorklet: GTCRN أو RNNoise (تركيز المتحدث)
  → إعادة معدل العينات إلى 16kHz mono PCM16
  → WebSocket → ClassRoom DO
       DO: SpeexDSP (تحقق/إعادة معدل فقط) → Gemini Live (`audio/pcm;rate=16000`)
```

ميزانية الموارد: VAD أقل من 1ms + مزيل أقل من 1ms لكل إطار 10–32ms ⇒ **أقل من 10% من نواة واحدة** على Chromebook من 2020.

توصيات إضافية:
- **إظهار حالة المعالجة المطبقة للمستخدم:** بدلًا من `console.warn` فقط، أظهر إشارة في الواجهة (بالعربية) عندما لا يطبّق المتصفح NS/AGC، مع اقتراح بديل لاختيار ميكروفون آخر.
- أضف مفتاحًا في الإعدادات لتشغيل/تعطيل AGC و`noiseSuppression` — يجب تعطيل AGC خصوصًا في البيئات الضوضائية بعد إضافة مزيل الضوضاء.
- التدرج في الحل: يبقى خيار BVC من Krisp بديلًا لاحقًا إن رُفضت جودة RNNoise/GTCRN في اختبارات استماع ميدانية في غرف عربية (رخصة تجارية مطلوبة).

---

## الجزء الثاني: المشكلة (B) — انقطاع الترجمة عند الكتم واستئناف الكلام القديم عند الفتح

### 1. ما يحدث حاليًا في الكود (جذور المشكلة)

السلوك الحالي **مُبرمج بوعي** في الكود والتوثيق (وليس عطلًا عرضيًا): عند الكتم — طوعيًا `mic-close` أو قسريًا `mute{pid}` — يحدث بالتتابع (`mic.ts:124-135, 173-191` ← `room.ts applyMicEffects :616-643`):

1. **`flushSpeaker(idx)`** ← `endInput()` ← يُرسل إلى Gemini `{"realtimeInput":{"audioStreamEnd":true}}` (`gemini.ts:369-384`). هذه عملية **تصفية (flush) أو معالجة بدون إحباط**: Gemini تكمل ترجمة كل ما وصلها بالفعل وتبث الأصوات المترجمة حتى `turnComplete`.
2. **`closeSpeakerPipes(idx)`** (`sessions.ts:343-350`) ← تمحو مراجع المستمعين وتضبط **مؤقت إغلاق خامل بعد `DEFAULT_IDLE_CLOSE_MS = 60_000`** — أي أن اتصال الجلسة إلى Gemini **يبقى مفتوحًا وساخنًا (warm)** مع كامل سياق المحادثة و`resumeHandle` (`gemini.ts:65-69, 178-181`). هذا مقصود؛ الاختبار `sessions.test.ts:331-344` يثبّت السلوك: "closeSpeakerPipes keeps the pipe warm inside the idle window (tail drains)"، والتوثيق `docs/MIC-CONTROL.md:39,50-52` و`docs/PROTOCOL.md:137-146` يقرر: "الذيلة تكمل دورها، ولا شيء يُقطع أثناء التشغيل".

#### 1.2 لماذا ينقطع الصوت عند المستمع رغم أن "الذيلة" مبرمجة أن تستمر؟

لا يوجد شيء في الخادم يوقف الترجمة عند الكتم — `forwardTranslated` (`room.ts:1039-1071`) لا يراجع مراجع المستمعين؛ بل يبث إلى **كل سوكت حي بمطابقة targetLang** — الذيلة تصل فعلًا. الأسباب المرشحة للانقطاع وسط البث:

**(أ) عتبة التأخير المسبق 400ms بعد الجفاف (Underrun) تلقّم ذيولًا قصيرة**
`web/src/audio/playback.ts:42, 275-280, 346-352`:
- عند الجفاف (نفاد المخزون: وصول حزم أبطأ من التشغيل) تُعاد ضبط `nextTime` و`expectedSeq`.
- بعد إعادة الضبط لا يبدأ التشغيل إلا بعد تراكم **400ms من الصوت الجديد** (`PLAYBACK_PRE_ROLL_MS`).
- النتيجة: **أي ذيل ترجمة أقصر من 400ms بعد فجوة يجلس في `pending` للأبد ولا يُشغّل** — انقطاع وسط جملة. وكل فجوة توليد جديدة تُعيد تشغيل العدّاد نفسه.

**(ب) سلوك `audioStreamEnd` عند Gemini نفسها**
قياسات مستقلة ([Anecho Engineering, 2026](https://anecho.ai/blog/gemini-live-audio-stream-end)؛ [python-genai issue #1328](https://github.com/googleapis/python-genai/issues/1328)) على نماذج native-audio: إرسال `audio_stream_end=true` **وحده** (بعد توقف الإطارات مباشرة) أعاد 0 بايت من الخرج؛ بينما أرسل الذيل مع **1.5 ثانية من عينات صمت حقيقية** فأعاد 229,994 بايت. الخلاصة: **النموذج لا يُنهي الدور الأدبي إلا عندما يسمع صمتًا حقيقيًا كعينات فعلية**؛ توقف الإرسال بلا ذيل صمت يُقرأ كعميل انقطع. التطبيق الحالي لا يرسل أي ذيل صمت عند الكتم.
- ملاحظة مهمة: التوثيق الرسمي متضارب (وثائق AI-Studio تقول إن `audioStreamEnd` يتصفّي الكاش فورًا؛ ووثائق Vertex تقول إنه تجاوز انتظار الصمت) — **اعتبار "إرسال عينات صمت حقيقية" هو المسار الآمن** حتى يُعاد قياس السلوك على النموذج المستخدم فعلًا `gemini-3.5-live-translate-preview`.

### 1.3 لماذا يُستأنف الكلام القديم عند فتح الميكروفون من جديد؟

هذه هي الآلية المتراكمة المفسّرة للشكوى:

1. عند الكتم: `flushSpeaker` (تصفية) + `closeSpeakerPipes` (تُخلي المراجع وتُبقي جلسة Gemini **ساخنة 60 ثانية** — `sessions.ts:343-350`).
2. Gemini تواصل توليد ترجمة الدور الطويل؛ `onAudio` ← `forwardTranslated` تُبَسط إلى كل سوكت حي مطابق اللغة — فالمستمع يستمر بسماع **ذيلة الكلام القديم بعد الكتم** (مقصود بحسب التوثيق).
3. المتحدث يفتح الميكروفون خلال نافذة الـ 60s ← `mic-open` ← `prewarmSessions` (`room.ts:1014-1032`) ← `manager.acquire` بنفس مفتاح الأنبوب `speakerIndex:src->tgt` (`sessions.ts:257`) ← **تعيد نفس الجلسة الساخنة** (يمر الاختبار `sessions.test.ts:331-344`).
4. السياق القديم ما زال محمّلًا (sessionResumption + contextWindowCompression — `gemini.ts:65-69, 129-134, 178-181`)، والإطارات الجديدة تُقحم في الجلسة نفسها؛ قد يُكمل النموذج/يستأنف إِخراج الدور السابق، فتسمعه المستمعون كأنه "الكلام القديم يُستأنف". **لا يوجد في أي موضع مسار لإسقاط مدخلات/مخرجات الدور السابق** — `endInput` تصفية وليست حرقًا، و`close()` (المسار الوحيد) يُستدعى فقط في مسارات الإغلاق الخامل/اليتيم (`gemini.ts:386-396`).
5. إضافة عميلية صغيرة: الوركتلت يدعم رسالة `{type:"reset"}` لمحو الإطار الجزئي (`capture.worklet.js:83-88`) — **لا شيء على الخيط الرئيسي يرسلها**؛ عند فتح الميكروفون تُرسل حتى 99ms من عينات ما قبل الكتم ممتزجة بأول إطار جديد — نزيف عيّنات قديمة بعد الفتح.

### 1.4 الخلاصة التشخيصية للمشكلة (B)

| العَرَض | الآلية |
|---|---|
| انقطاع الترجمة عند الكتم | عتبة الـ 400ms في أدوات التشغيل بعد كل جفاف (`playback.ts`) + احتمال ألا يُنهي Gemini الدور أصلًا بلا ذيل صمت حقيقي (قياس Anecho) |
| استئناف الكلام القديم عند الفتح | جلسة Gemini تبقى حيّة وساخنة 60s بنفس السياق؛ لا يوجد مسار حرق لأجزاء الدور السابق؛ نزيف الإطار الجزئي من الوركتلت |

### 2. المعايير المطلوبة (إعادة صياغة السلوك الهدف)

- عند الكتم: كل ما قيل **قبل** الكتم يُترجَم ويُشغَّل عند المستمعين حتى النهاية (تفريغ كامل)، والتشغيل الجاري لا يُقطع أبدًا.
- عند الفتح من جديد: **يُسقط كل ما لم تُترجَمه بعد** من الدور السابق؛ لا تُترجم إلا المقاطع الجديدة بعد الفتح.
- لا يجوز إغلاق سوكت Gemini عند الكتم (فقدان ترجمات جارية + كلفة إعادة ربط).

### 3. الأنماط المرجعية من المقيمين والمزودين (نتائج البحث)

| # | النمط | المصدر التعليمي |
|---|---|---|
| 1 | **عدّاد حقب (Epoch/Generation) عند الكتم**: كل إطار/مقطع يحمل رقم الحقبة. عند الكتم تُرفع الحقبة للمُدخلات الجديدة، بينما تبقى مخرجات الحقبة القديمة تُبث حتى `turnComplete` | LiveKit Agents: `livekit-plugins-ultravox/realtime/realtime_model.py` يحتفظ `_pending_generation_epoch`؛ و`livekit-plugins-slng/tts.py` يرفع `_standby_epoch` عند كل تغيير إعداد |
| 2 | **تصفية-ثم-بوابة على المدخل**: عند الكتم يتوقف إرسال PCM + `audioStreamEnd` + **ذيل عينات صمت حقيقية (~500ms)** + بقاء حلقة الاستقبال مفتوحة؛ الانتظار على `turnComplete` أو انتهاء مهلة محدودة (نمط LiveKit `FINALIZE_TIMEOUT = 2s` في `gemini_stt.py`) | Deepgram `Finalize`/`UtteranceEnd`; AssemblyAI `end_of_turn`; قياس Anecho |
| 3 | **مخزن إعادة تشغيل عند المستمع (درن-ثم-مُهمل)**: كل مقطع مُختم `{speakerId, epoch, seq, pcm}`. عند الكتم `draining=true`: يُشغَّل حتى نفاد المخزون + رؤية نجاح الحقبة. عند فتح جديد `draining=false` ويُسقط أي مقطع بحقبة أقدم | WebRTC NetEQ (مخزون امتزاج التأخير)؛ امتداد RTP لـ playout-delay؛ نمط VS Code `_interruptedAudioIds` |
| 4 | **وصفيات واضحة على السوكت الخاصة بكم**: إطارات تحكم صريحة `{type:'finalize', turnId}` و`{type:'cancel', turnId}` تُترجم إلى `audioStreamEnd`/إعادة جلسة بدلًا من الاعتماد على كشف Gemini تلقائي | Deepgram Finalize؛ AssemblyAI Flush/FlushDone/Cancel |
| 5 | **الاعتماد على `interrupted` من Gemini وحده**: مناسب لقطع توليد النموذج عند مداخلة مستخدم ثانوي (barge-in) — **لا يحل مشكلة الكتم**، لأن الكتم ليس مداخلة تفرض الحرق على النموذج بل تصفية يُقصد بتفريغها | توثيق Gemini Live: "عند `interrupted`: أوقف التشغيل وامحو قائمة البث" |

مصادر أساسية عن دلالات الإنهاء لدى المزودين: توثيق Gemini Live (turnComplete/generationComplete/interrupted/waitingForInput — [Reference](https://ai.google.dev/api/live))؛ دعم VAD الهجين (VAD عميل لنهاية الكلام + VAD خادم لبدئه، مع prefixPaddingMs 500–800ms — [Capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities))؛ الاحتياطات العملية (تقسيم الإطارات 20–40ms — [Best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices)).

### 4. توصية المشكلة (B) — مخطط التنفيذ المرشّح (دمج الأنماط 1+2+3)

**تعديلات مقترحة (بحسب `docs/PROTOCOL.md` أولًا ثم الكود):**

1. **حقبة المتحدث (speakerEpoch)**: رقم يبدأ بـ 1، يتزايد عند كل كتم/فتح. يُختم على كل إطار PCM من العميل (بادئة صغيرة في نفس إطار `encodeAudioFrame` أو في ترويسة التحكم).
2. عند الكتم (طوعي أو قسري) يرسل العميل إشارة كتم تحمل الحقبة، ويجب أن تتضمن: `audioStreamEnd` إلى Gemini **+ ذيل ~500ms عينات صمت حقيقية عبر نفس الأنبوب** (لا نعتمد على `audioStreamEnd` وحدها بحسب قياس Anecho).
3. الـ DO يستقبل مخرجات Gemini كما هي ويُبثها طالما أنها من الحقبة السابقة (تفريغ)، ولا يقبل مدخلات إطارات جديدة إلا بالحقبة الأحدث.
4. عند الفتح من جديد: تُرفع الحقبة، وتُسقط أي مخرجات تصل من الجلسة لا تزال تنتمي لدور قديم لم يُنهَ بعد — **باستبدال بثّها أو تفريغها فورًا**، والقرار التفصيلي (تفريغ ذيل مكتمل مسبقًا مقابل حرق غير المُترجَم بعد) يُحدَّد بعد تجارب مناسبة قبل التنفيذ.
5. عند المستمع: مخزن مؤقَّت مرتَّب `{speakerId, epoch, seq}`؛ وضع `draining=true` عند إشارة الكتم بحيث يُشغَّل كل ما هو مخزّن حتى النهاية، و`turnComplete` للحقبة القديمة يُهوّي نهاية الحقبة؛ ولأي مقطع بحقبة أقدم بعد فتح جديد: إسقاط.
6. معالجة نزيف العيّنات: إرسال رسالة الوركتلت `{type:"reset"}` موجودة فعليًا لكنها غير مستخدمة — استدعاؤها عند `stopSource()` يمنع مزج ما قبل الكتم بأول إطار بعد الفتح.
7. مهلة تفريغ محدودة على الـ DO (مثال 2–3 ثوانٍ بعد آخر مخرج) حتى لا تُعطّل دورة Gemini عالقة الغرفة للأبد؛ عند المهلة يُحتسب نجاح الحقبة إجباريًا.

**تحسين متعاظم: VAD هجين للمعلم** — VAD عميل (Silero، مع redemptionMs ≈ 500–800 ملائم لإيقاع الكلام العربي) يوجّه إرسال `audioStreamEnd` عند نهاية الكلام فعليًا، مع بقاء VAD الخادم احتياطًا — هذا هو المسار الموصوف توثيقيًا لدى Gemini.

**مؤشرات قياس إلزامية (بحسب `docs/TEST-PLAN.md`):** `queueDepthMs`, `drainActive`, `droppedStaleChunks`, `epoch` لكل مستمع — بحيث يمكن إثبات التفريغ في لوحة المؤشرات وعند فحص E2E.

---

## الجزء الثالث: ملخص التوصيات مرتبة بالأولوية

| الأولوية | التغيير | يعالج | الجهد التقريبي |
|---|---|---|---|
| 1 | إرسال ذيل عينات صمت (~500ms) مع `audioStreamEnd` عند الكتم + مهلة تفريغ محدودة على الـ DO | انقطاع الذيلة | نصف يوم |
| 2 | حقبة `speakerEpoch` + إسقاط مخرجات الدور القديم بعد الفتح + تحديث `docs/PROTOCOL.md` | استئناف الكلام القديم | يوم |
| 3 | تشغيل رسالة الوركتلت `reset` عند الكتم | يعالج نزيف عيّنات قديمة | دقائق |
| 4 | عتبة 400ms: السماح ببدء تشغيل ذيول أقصر عند دوران `draining` (تخفيض العتبة أو اعتماد إشارة نهاية التوليد كبديل) | ذيول أصغر من 400ms لا تشغَّل | نصف يوم |
| 5 | مزيل ضوضاء عميل (`@sapphi-red/web-noise-suppressor` — GTCRN أو RNNoise) داخل مسار الوركتلت الحالي + Silero VAD لبوابة الإرسال | التقاط الضوضاء المحيطة | يوم–يومان |
| 6 | إظهار حالة المعالجة المطبقة بالمستمع في الواجهة + مفتاح إعدادات AGC/NS | شمولية تجربة المستخدم | نصف يوم |
| 7 | `voiceIsolation: true` خلف فحص `getSupportedConstraints()` (ChromeOS والمنصات الداعمة) | تركيز أعلى حيث يوفره المتصفح | ساعة |

**المخاطر والتحفظات (بأمانة):**
- سلوك `audioStreamEnd` متفاوت بين وثائق AI-Studio وVertex والقياسات الفعلية؛ يجب قياسه على النموذج `gemini-3.5-live-translate-preview` نفسه قبل اعتماد المسار (تقدير 30–60 دقيقة عمل تجريبي).
- جودة GTCRN/RNNoise على كلام عربي مفرد في غرفة مزدحمة يحتاج اختبار استماع بشري قبل الاعتماد عليه (عينة من غرف كلاس حقيقية).
- رخصة Krisp (إن دُخلنا خيار BVC لاحقًا) تجارية وتحتاج مراجعة ميزانية/قانونية.
- في Chrome لسطح المكتب لا يمكن لتطبيق ويب فرض "Voice Focus" على مستوى النظام؛ رخصة المستخدم أو راية المتصفح هي التي تحكم — لذا المعالجة داخل التطبيق ضرورة لا تجميل.

---

## ملحق: المصادر

**المشكلة (A):**
- قيد W3C `voiceIsolation`: https://w3c.github.io/mediacapture-extensions/#voiceisolation-constraint
- إطالة Chrome (ChromeOS M123): https://groups.google.com/a/chromium.org/g/blink-dev/c/hPMvCu-3iPA
- Chromium: تعطيل القيد خارج ChromeOS: https://chromium.googlesource.com/chromium/src/+/39c643d27f71ba03f9ea9472dd6c51673c30760a
- Chromium VoiceIsolationHandler (مزيل Meet): https://chromium.googlesource.com/chromium/src/+/HEAD/services/audio/voice_isolation_handler.cc
- Chrome 141 ووضع echoCancellation: https://developer.chrome.com/release-notes/141 · https://groups.google.com/a/chromium.org/g/blink-dev/c/x5nfoaUAUWY
- Windows 11 24H2 System AEC / Voice Clarity: https://windowsreport.com/chrome-integrates-windows-11-24h2-audio-echo-cancellation/
- `@sapphi-red/web-noise-suppressor`: https://github.com/sapphi-red/web-noise-suppressor
- وركتلت Jitsi RNNoise: https://github.com/jitsi/jitsi-meet/blob/master/react_features/stream-effects/noise-suppression/NoiseSuppressorWorklet.ts
- مقاييس Silero VAD بالمتصفح: https://github.com/FluidInference/fluidaudio-web/blob/main/docs/BENCHMARKS.md · https://micdrop.dev/blog/voice-activity-detection-browser
- Silero VAD داخل Workers (0.7ms): https://github.com/snakers4/silero-vad/discussions/760
- توثيق Krisp Web SDK والرخص: https://sdk-docs.krisp.ai/docs/web-browser-sdk · https://sdk-docs.krisp.ai/docs/licensing-information
- توثيق LiveKit مع فلتر Krisp ("لا تكدّس النماذج المحسّنة"): https://docs.livekit.io/transport/media/noise-cancellation/ · https://www.npmjs.com/package/@livekit/krisp-noise-filter
- MDN getUserMedia: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- اتفاق الافتراضية EC/NS/AGC: https://github.com/w3c/mediacapture-main/issues/777

**المشكلة (B):**
- توثيق Gemini Live API (دلالات turnComplete/interrupted/generationComplete): https://ai.google.dev/api/live
- تكات Gemini Live (VAD تلقائي/هجين، silenceDurationMs): https://ai.google.dev/gemini-api/docs/live-api/capabilities
- أفضل ممارسات Gemini Live: https://ai.google.dev/gemini-api/docs/live-api/best-practices
- التبديل الهجين VAD والبث الحرفي: https://ai.google.dev/gemini-api/docs/live-api/live-transcribe
- قياس Anecho أن `audio_stream_end` لا ينهي الدور على Vertex: https://anecho.ai/blog/gemini-live-audio-stream-end
- googleapis/python-genai issue #1328: https://github.com/googleapis/python-genai/issues/1328
- LiveKit Turn Detector والإنهاء: https://docs.livekit.io/agents/logic/turns/turn-detector/ · https://livekit.com/blog/solving-end-of-turn-detection
- أنماط Epoch لدى LiveKit: https://github.com/livekit/agents/blob/main/livekit-plugins/livekit-plugins-ultravox/livekit/plugins/ultravox/realtime/realtime_model.py · https://github.com/livekit/agents/blob/main/livekit-plugins/livekit-plugins-slng/livekit/plugins/slng/tts.py
- مهلة إنهاء Gemini لدى LiveKit: https://github.com/livekit/agents/blob/main/livekit-plugins/livekit-plugins-google/livekit/plugins/google/beta/gemini_stt.py
- Deepgram Finalize / UtteranceEnd: https://developers.deepgram.com/docs/finalize · https://developers.deepgram.com/docs/understanding-end-of-speech-detection
- AssemblyAI turn detection وTTS Flush/Cancel: https://www.assemblyai.com/docs/streaming/turn-detection · https://www.assemblyai.com/docs/tts/message-frames
- مخزون WebRTC NetEQ: https://github.com/blueboxd/webrtc/blob/master.lion/modules/audio_coding/neteq/g3doc/index.md
- امتداد playout-delay: https://webrtc.github.io/webrtc-org/experiments/rtp-hdrext/playout-delay/
- معدل الصوت لدى Cloudflare Agents: https://github.com/cloudflare/agents/blob/main/ideas/voice.md
- نمط VS Code لإدارة الدور المنقطع: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/voiceClient/voiceSessionController.ts
