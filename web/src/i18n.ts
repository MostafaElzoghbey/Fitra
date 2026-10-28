// T-013: full UI dictionary. Arabic is the source language (NFR-004); en/fr/es
// must stay complete or the build breaks, because `Record<SupportedUiLang, …>`
// is exhaustive over the union.

export type SupportedUiLang = "ar" | "en" | "fr" | "es";

export const SUPPORTED_UI_LANGS: readonly SupportedUiLang[] = [
  "ar",
  "en",
  "fr",
  "es",
];

export const DEFAULT_UI_LANG: SupportedUiLang = "ar";

/** BCP-47 audio languages offered for listening + speaking (SPEC FR-006). */
export type ParticipantLang = "ar" | "en" | "fr" | "es";

export const PARTICIPANT_LANGS: readonly ParticipantLang[] = [
  "ar",
  "en",
  "fr",
  "es",
];

export function isSupportedUiLang(value: string): value is SupportedUiLang {
  return (SUPPORTED_UI_LANGS as readonly string[]).includes(value);
}

export function isParticipantLang(value: string): value is ParticipantLang {
  return (PARTICIPANT_LANGS as readonly string[]).includes(value);
}

export function dirFor(lang: SupportedUiLang): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}

/** Renders the teacher's own speech, so it is never translated (FR-015). */
export function nativeNameOf(lang: ParticipantLang): string {
  switch (lang) {
    case "ar":
      return "العربية";
    case "en":
      return "English";
    case "fr":
      return "Français";
    case "es":
      return "Español";
    default:
      return assertNever(lang);
  }
}

export function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

export type TranslationVars = Readonly<Record<string, string | number>>;

export function fmt(template: string, vars: TranslationVars): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const found: string | number | undefined = vars[key];
    return found === undefined ? match : String(found);
  });
}

export type ErrorCode =
  | "unauthorized"
  | "teacher-taken"
  | "room-full"
  | "unsupported-language"
  | "not-your-floor"
  | "rate-limited"
  | "frame-too-large"
  | "session-degraded"
  | "room-closed"
  | "creation-disabled"
  | "unknown-room"
  | "invalid-body"
  | "server-misconfigured"
  | "network";

export type ConsentPointKey =
  | "consentAi"
  | "consentFreeTier"
  | "consentNoRecording"
  | "consentLeave"
  | "consentMinors";

export type SessionStatusKey =
  | "statusConnecting"
  | "statusLive"
  | "statusReconnecting"
  | "statusFailed"
  | "statusDegraded";

export interface UiStrings {
  readonly appTitle: string;
  readonly appTagline: string;
  readonly uiLangLabel: string;
  readonly navHome: string;
  readonly navCreate: string;
  readonly navJoin: string;

  readonly homeLead: string;
  readonly homeCreateCta: string;
  readonly homeJoinCta: string;
  readonly homeStep1Title: string;
  readonly homeStep1Body: string;
  readonly homeStep2Title: string;
  readonly homeStep2Body: string;
  readonly homeFloorTitle: string;
  readonly homeFloorBody: string;

  readonly createTitle: string;
  readonly createLead: string;
  readonly createConsentLead: string;
  readonly createDoneTitle: string;
  readonly createDoneLead: string;
  readonly createCodeLabel: string;
  readonly createShareHint: string;
  readonly createEnterRoom: string;

  readonly joinTitle: string;
  readonly joinLead: string;
  readonly joinBlockedNotice: string;
  readonly joinRoleHint: string;

  readonly fieldNameLabel: string;
  readonly fieldNamePlaceholder: string;
  readonly fieldTeacherLangLabel: string;
  readonly fieldRoomCodeLabel: string;
  readonly fieldRoomCodePlaceholder: string;
  readonly fieldRoleLabel: string;
  readonly fieldLangLabel: string;

  readonly toggleAutoGrantLabel: string;
  readonly toggleAutoGrantHelp: string;
  readonly toggleClassmatesLabel: string;
  readonly toggleClassmatesHelp: string;
  readonly consentConfirmLabel: string;

  readonly consentTitle: string;
  readonly consentIntro: string;
  readonly consentInArabic: string;
  readonly consentInYourLang: string;
  readonly consentTerms: string;
  readonly consentAccept: string;
  readonly consentDecline: string;
  readonly consentDeclinedNotice: string;
  readonly consentAi: string;
  readonly consentFreeTier: string;
  readonly consentNoRecording: string;
  readonly consentLeave: string;
  readonly consentMinors: string;

  readonly roleTeacher: string;
  readonly roleStudent: string;

  readonly submitCreate: string;
  readonly submitJoin: string;
  readonly submitting: string;

  readonly roomTitle: string;
  readonly roomLeave: string;
  readonly floorIdle: string;
  readonly floorTeacher: string;
  readonly floorStudent: string;
  readonly floorYours: string;
  readonly floorNone: string;
  readonly floorWaiting: string;
  readonly raiseHand: string;
  readonly lowerHand: string;
  readonly handRaisedBadge: string;
  readonly handsSummaryNone: string;
  readonly handsSummaryOne: string;
  readonly handsSummaryMany: string;
  readonly revokeFloor: string;
  readonly grantFloor: string;
  readonly denyRequest: string;
  readonly rosterTitle: string;
  readonly rosterEmpty: string;
  readonly rosterYou: string;
  readonly micLabel: string;
  readonly micOn: string;
  readonly micOff: string;
  readonly micHint: string;
  readonly micDeniedHint: string;
  readonly micDeviceLostHint: string;
  readonly headphonesHint: string;
  readonly generatedVoiceNote: string;
  readonly testDeploymentBadge: string;
  readonly captionsTitle: string;
  readonly captionsEmpty: string;
  readonly captionsInputLabel: string;
  readonly captionsOutputLabel: string;
  readonly sessionsTitle: string;
  readonly sessionsEmpty: string;
  readonly statusConnecting: string;
  readonly statusLive: string;
  readonly statusReconnecting: string;
  readonly statusFailed: string;
  readonly statusDegraded: string;
  readonly metricsPlaceholder: string;
  readonly metricsTitle: string;
  readonly metricsWaiting: string;
  readonly metricsLatency: string;
  readonly metricsLatencySamples: string;
  readonly metricsLatencySource: string;
  readonly metricsLatencyServer: string;
  readonly metricsLatencyEmpty: string;
  readonly metricsSessionsTitle: string;
  readonly metricsSessionsEmpty: string;
  readonly metricsPair: string;
  readonly metricsStatus: string;
  readonly metricsReconnects: string;
  readonly metricsInbound: string;
  readonly metricsOutbound: string;
  readonly metricsErrors: string;
  readonly metricsDoActive: string;
  readonly connectionLost: string;
  readonly reconnect: string;

  readonly errorTitle: string;
  readonly errNameRequired: string;
  readonly errConsentRequired: string;
  readonly errLangRequired: string;
  readonly errCodeRequired: string;
  readonly errRoleRequired: string;
  readonly errNetwork: string;
  readonly errUnknownRoom: string;
  readonly errInvalidBody: string;
  readonly errUnsupportedLanguage: string;
  readonly errCreationDisabled: string;
  readonly errTeacherTaken: string;
  readonly errRoomFull: string;
  readonly errUnauthorized: string;
  readonly errNotYourFloor: string;
  readonly errRateLimited: string;
  readonly errFrameTooLarge: string;
  readonly errSessionDegraded: string;
  readonly errRoomClosed: string;
  readonly errServer: string;
  readonly errUnknown: string;

  readonly langNameAr: string;
  readonly langNameEn: string;
  readonly langNameFr: string;
  readonly langNameEs: string;

  readonly backHome: string;
}

const STRINGS: Record<SupportedUiLang, UiStrings> = {
  ar: {
    appTitle: "فترا",
    appTagline: "مختبر الترجمة الفورية",
    uiLangLabel: "لغة الواجهة",
    navHome: "الرئيسية",
    navCreate: "إنشاء صف",
    navJoin: "الانضمام",

    homeLead:
      "معلّم يتحدّث بلغته، وطلبة في بلدان أخرى يسمعون بلغاتهم — ترجمة فورية للصوت، ولا تسجيل في أي مرحلة.",
    homeCreateCta: "إنشاء صف",
    homeJoinCta: "الانضمام برمز",
    homeStep1Title: "١ — المعلّم ينشئ صفًا",
    homeStep1Body:
      "اختر لغتك ولغات الصف، واحصل على رمز قصير تشاركه مع الطلبة.",
    homeStep2Title: "٢ — الطالب ينضم بالرمز",
    homeStep2Body:
      "يكتب الرمز واسمه ولغته، ويوافق على إشعار الموافقة قبل تشغيل الميكروفون.",
    homeFloorTitle: "قاعدة الصف",
    homeFloorBody:
      "متحدّث واحد فقط في كل لحظة. يرفع الطالب يده، فيمنح المعلّم الأرضية أو يرفضها، ويمكنه سحبها في أي وقت.",

    createTitle: "إنشاء صف",
    createLead: "اضبط إعدادات الصف، وستحصل على رمز تشاركه مع الطلبة.",
    createConsentLead:
      "قبل إنشاء الصف، يجب أن تؤكد أنك حصلت على موافقة الطالب (وأولياء أمور القُصّر) على إشعار الموافقة والخصوصية.",
    createDoneTitle: "جاهز",
    createDoneLead: "شارك هذا الرمز مع الطلبة. ينتهي الرمز للالتحاق بعد ١٠ دقائق.",
    createCodeLabel: "رمز الصف",
    createShareHint: "اكتب الرمز كما هو. الحروف والأرقام فقط.",
    createEnterRoom: "الدخول إلى الصف كمعلّم",

    joinTitle: "الانضمام إلى صف",
    joinLead: "أدخل رمز الصف واسمك ودورك ولغتك.",
    joinBlockedNotice:
      "الموافقة إلزامية قبل تشغيل الميكروفون. اقرأ الإشعار ثم وافق للمتابعة.",
    joinRoleHint: "يوجد معلّم واحد فقط لكل صف.",

    fieldNameLabel: "الاسم الظاهر",
    fieldNamePlaceholder: "مثال: ليان",
    fieldTeacherLangLabel: "لغة المعلّم",
    fieldRoomCodeLabel: "رمز الصف",
    fieldRoomCodePlaceholder: "مثال: K7M2QX",
    fieldRoleLabel: "الدور",
    fieldLangLabel: "لغتي (استماع + كلام)",

    toggleAutoGrantLabel: "منح الأرضية تلقائيًا",
    toggleAutoGrantHelp:
      "معطّل افتراضيًا. عند تفعيله يُمنح الطالب الأرضية فور رفع يده.",
    toggleClassmatesLabel: "يسمع الطلبةُ بعضهم",
    toggleClassmatesHelp:
      "مفعّل افتراضيًا. عند إيقافه يسمع الطالب الوحيد المعلّم ولا يسمعه زملاؤه.",
    consentConfirmLabel:
      "أؤكد أنني أبلغت 모든 الطلبة بإشعار الموافقة، وأن أولياء أمور القُصّر قد وافقوا",

    consentTitle: "إشعار الموافقة والخصوصية",
    consentIntro:
      "قبل تشغيل الميكروفون، اقرأ ما يلي بعناية:",
    consentInArabic: "بالعربية",
    consentInYourLang: "بلغتك",
    consentTerms: "شروط استخدام Gemini وبياناته",
    consentAccept: "أوافق وأتابع",
    consentDecline: "لا أوافق",
    consentDeclinedNotice:
      "لا يمكن المتابعة دون الموافقة. يمكنك قراءة الإشعار في أي وقت ثم العودة.",
    consentAi:
      "صوتك يُترجَم لحظيًا بواسطة خدمة ذكاء اصطناعي (Google Gemini). الصوت يُنقل مباشرة عبر الخادم ولا يُخزَّن فيه.",
    consentFreeTier:
      "في النسخة التجريبية المجانية قد تستخدم Google المحتوى المُرسل لتحسين منتجاتها، وقد يطّلع عليه مراجعون بشريون. النسخة الإنتاجية تستخدم الاشتراك المدفوع الذي لا يُستخدم فيه المحتوى للتدريب.",
    consentNoRecording:
      "لا تُسجَّل أي محادثة صوتية من طرف فترا: لا في الخادم ولا في المتصفح.",
    consentLeave:
      "يمكنك مغادرة الصف في أي وقت بزر واحد، دون أي أثر يُحفظ.",
    consentMinors:
      "إن كان الطالب قاصرًا، فهذه الإشعار موجّه إلى ولي الأمر، ويجب أن يوافق أولياء أمور القُصّر قبل الدخول.",

    roleTeacher: "معلّم",
    roleStudent: "طالب",

    submitCreate: "إنشاء الصف",
    submitJoin: "الدخول إلى الصف",
    submitting: "جارٍ…",

    roomTitle: "الصف",
    roomLeave: "مغادرة الصف",
    floorIdle: "الصف صامت الآن",
    floorTeacher: "المعلّم يتحدّث",
    floorStudent: "{name} يتحدّث",
    floorYours: "الأرضية بيدك",
    floorNone: "لا أحد يتحدّث",
    floorWaiting: "بانتظار متحدّث",
    raiseHand: "ارفع اليد",
    lowerHand: "اخفض اليد",
    handRaisedBadge: "اليد مرفوعة",
    handsSummaryNone: "لا توجد أيدٍ مرفوعة",
    handsSummaryOne: "يد واحدة مرفوعة",
    handsSummaryMany: "{count} أيدٍ مرفوعة",
    revokeFloor: "سحب الأرضية",
    grantFloor: "منح الأرضية",
    denyRequest: "رفض الطلب",
    rosterTitle: "الحضور",
    rosterEmpty: "لا أحد بعد.",
    rosterYou: "أنت",
    micLabel: "اختبار الميكروفون",
    micOn: "الميكروفون يعمل",
    micOff: "الميكروفون مكتوم",
    micHint:
      "اضغط لاختبار الميكروفون. تشغيل الصوت يتطلّب نقرة صريحة منك.",
    micDeniedHint:
      "رُفض إذن الميكروفون. فعّله من إعدادات المتصفح ثم أعد المحاولة.",
    micDeviceLostHint:
      "لم يعد الميكروفون المختار متاحًا، فاتّجه الصوت إلى الميكروفون الافتراضي.",
    headphonesHint:
      "استخدم سمّاعة رأس لتفادي الصدى وخلط الأصوات في الغرفة.",
    generatedVoiceNote:
      "الصوت المترجم مُولَّد بالذكاء الاصطناعي، وليس صوت المتحدّث الأصلي.",
    testDeploymentBadge: "نشر تجريبي — ترجمة ذكاء اصطناعي، بلا تسجيل من طرفنا",
    captionsTitle: "الترجمة النصية",
    captionsEmpty: "لا تتوفّر ترجمة نصية في هذا المحرك بعد.",
    captionsInputLabel: "كلام المتحدّث",
    captionsOutputLabel: "الترجمة",
    sessionsTitle: "جلسات الترجمة",
    sessionsEmpty: "لا توجد جلسات بعد.",
    statusConnecting: "جارٍ الاتصال",
    statusLive: "مباشر",
    statusReconnecting: "إعادة الاتصال",
    statusFailed: "فشلت",
    statusDegraded: "متدهور",
    metricsPlaceholder: "ستظهر لوحة القياس هنا.",
    metricsTitle: "القياس المباشر",
    metricsWaiting: "بانتظار أول تقرير من الخادم.",
    metricsLatency: "زمن الاستجابة من طرف إلى طرف",
    metricsLatencySamples: "{count} عيّنة",
    metricsLatencySource: "تقدير محلي من هذا المتصفّح",
    metricsLatencyServer: "تقدير من الخادم",
    metricsLatencyEmpty: "بانتظار أول مقطع مُترجَم",
    metricsSessionsTitle: "جلسات الترجمة",
    metricsSessionsEmpty: "لا توجد جلسات بعد.",
    metricsPair: "الزوج",
    metricsStatus: "الحالة",
    metricsReconnects: "إعادة الاتصال",
    metricsInbound: "رسائل داخل/ث",
    metricsOutbound: "رسائل خارج/ث",
    metricsErrors: "أخطاء آخر دقيقة",
    metricsDoActive: "نشاط الخادم (ث)",
    connectionLost: "انقطع الاتصال بالصف.",
    reconnect: "إعادة الاتصال",

    errorTitle: "حدث خطأ",
    errNameRequired: "اكتب اسمك الظاهر.",
    errConsentRequired: "الموافقة إلزامية قبل الدخول.",
    errLangRequired: "اختر لغتك.",
    errCodeRequired: "اكتب رمز الصف.",
    errRoleRequired: "اختر دورك.",
    errNetwork: "تعذّر الاتصال بالخادم.",
    errUnknownRoom: "لا يوجد صف بهذا الرمز.",
    errInvalidBody: "البيانات المُرسلة غير صالحة.",
    errUnsupportedLanguage: "هذه اللغة غير مدعومة بعد.",
    errCreationDisabled: "إنشاء الصفوف متوقّف مؤقتًا.",
    errTeacherTaken: "يوجد معلّم في هذا الصف بالفعل.",
    errRoomFull: "الصف ممتلئ.",
    errUnauthorized: "انتهت صلاحية رمز الدخول أو أنه غير صالح.",
    errNotYourFloor: "الأرضية ليست بيدك.",
    errRateLimited: "عدد الرسائل كبير جدًا، أبطئ قليلًا.",
    errFrameTooLarge: "إطار صوتي كبير جدًا.",
    errSessionDegraded: "تم تجاوز حد جلسات الترجمة، فبعض اللغات بلا صوت.",
    errRoomClosed: "أُغلق الصف.",
    errServer: "خطأ في الخادم.",
    errUnknown: "خطأ غير معروف.",

    langNameAr: "العربية",
    langNameEn: "الإنجليزية",
    langNameFr: "الفرنسية",
    langNameEs: "الإسبانية",

    backHome: "العودة للرئيسية",
  },

  en: {
    appTitle: "Fitra",
    appTagline: "Live speech translation lab",
    uiLangLabel: "Interface language",
    navHome: "Home",
    navCreate: "Create room",
    navJoin: "Join",

    homeLead:
      "A teacher speaks their own language; students abroad hear theirs — live voice translation, recorded nowhere.",
    homeCreateCta: "Create a room",
    homeJoinCta: "Join with a code",
    homeStep1Title: "1 — The teacher creates a room",
    homeStep1Body:
      "Pick your language and the class languages, and get a short code to share with students.",
    homeStep2Title: "2 — Students join with the code",
    homeStep2Body:
      "They enter the code, a display name and their language, and accept the privacy notice before the microphone turns on.",
    homeFloorTitle: "Floor rule",
    homeFloorBody:
      "Only one person speaks at a time. A student raises a hand; the teacher grants or denies it, and can revoke the floor at any time.",

    createTitle: "Create a room",
    createLead: "Set the room options, then share the code with your students.",
    createConsentLead:
      "Before creating the room, confirm that you told every student about the privacy notice and that guardians of minors have agreed to it.",
    createDoneTitle: "Ready",
    createDoneLead:
      "Share this code with your students. The join token expires 10 minutes after it is issued.",
    createCodeLabel: "Room code",
    createShareHint: "Read the code exactly as written — letters and digits only.",
    createEnterRoom: "Enter the room as teacher",

    joinTitle: "Join a room",
    joinLead: "Enter the room code, your display name, your role and your language.",
    joinBlockedNotice:
      "Consent is required before the microphone can start. Read the notice and accept to continue.",
    joinRoleHint: "A room has exactly one teacher.",

    fieldNameLabel: "Display name",
    fieldNamePlaceholder: "e.g. Layla",
    fieldTeacherLangLabel: "Teacher language",
    fieldRoomCodeLabel: "Room code",
    fieldRoomCodePlaceholder: "e.g. K7M2QX",
    fieldRoleLabel: "Role",
    fieldLangLabel: "My language (listen + speak)",

    toggleAutoGrantLabel: "Auto-grant the floor",
    toggleAutoGrantHelp:
      "Off by default. When on, a raised hand is granted immediately.",
    toggleClassmatesLabel: "Students hear each other",
    toggleClassmatesHelp:
      "On by default. When off, only the teacher hears a speaking student.",
    consentConfirmLabel:
      "I confirm that I informed every student about the privacy notice and that the guardians of any minors have consented",

    consentTitle: "Consent and privacy notice",
    consentIntro: "Before your microphone starts, please read carefully:",
    consentInArabic: "In Arabic",
    consentInYourLang: "In your language",
    consentTerms: "Gemini terms of use and its data policy",
    consentAccept: "I consent and continue",
    consentDecline: "I do not consent",
    consentDeclinedNotice:
      "You cannot continue without consent. You can reopen the notice at any time.",
    consentAi:
      "Your voice is translated live by an AI service (Google Gemini). The audio travels through the server and is not stored there.",
    consentFreeTier:
      "On the free test tier, Google may use the submitted content to improve its products, and human reviewers may read it. Production uses the paid tier, where content is not used for training.",
    consentNoRecording:
      "Fitra records no audio session: not on the server, and not in the browser.",
    consentLeave:
      "You can leave the room at any time with one button, and nothing is kept afterwards.",
    consentMinors:
      "If the student is a minor, this notice is addressed to the parent or guardian, who must agree before they join.",

    roleTeacher: "Teacher",
    roleStudent: "Student",

    submitCreate: "Create the room",
    submitJoin: "Join the room",
    submitting: "Working…",

    roomTitle: "Room",
    roomLeave: "Leave the room",
    floorIdle: "The room is quiet",
    floorTeacher: "The teacher is speaking",
    floorStudent: "{name} is speaking",
    floorYours: "You hold the floor",
    floorNone: "Nobody is speaking",
    floorWaiting: "Waiting for a speaker",
    raiseHand: "Raise hand",
    lowerHand: "Lower hand",
    handRaisedBadge: "Hand raised",
    handsSummaryNone: "No raised hands",
    handsSummaryOne: "One hand raised",
    handsSummaryMany: "{count} hands raised",
    revokeFloor: "Revoke floor",
    grantFloor: "Grant floor",
    denyRequest: "Deny",
    rosterTitle: "Participants",
    rosterEmpty: "Nobody here yet.",
    rosterYou: "You",
    micLabel: "Test microphone",
    micOn: "Microphone on",
    micOff: "Microphone muted",
    micHint:
      "Tap to test the microphone. Audio only starts after an explicit click from you.",
    micDeniedHint:
      "Microphone permission was denied. Enable it in your browser settings and try again.",
    micDeviceLostHint:
      "The selected microphone is gone, so audio switched to the default one.",
    headphonesHint:
      "Use headphones to avoid echo and mixed-up voices in the room.",
    generatedVoiceNote:
      "Translated audio is generated by AI, not the speaker's own voice.",
    testDeploymentBadge:
      "Test deployment — AI-translated, not recorded by us",
    captionsTitle: "Captions",
    captionsEmpty: "This engine does not provide transcripts yet.",
    captionsInputLabel: "Speaker",
    captionsOutputLabel: "Translated",
    sessionsTitle: "Translation sessions",
    sessionsEmpty: "No sessions yet.",
    statusConnecting: "Connecting",
    statusLive: "Live",
    statusReconnecting: "Reconnecting",
    statusFailed: "Failed",
    statusDegraded: "Degraded",
    metricsPlaceholder: "The metrics panel will appear here.",
    metricsTitle: "Live metrics",
    metricsWaiting: "Waiting for the first report from the server.",
    metricsLatency: "End-to-end latency",
    metricsLatencySamples: "{count} samples",
    metricsLatencySource: "Local estimate from this browser",
    metricsLatencyServer: "Reported by the server",
    metricsLatencyEmpty: "Waiting for the first translated chunk",
    metricsSessionsTitle: "Translation sessions",
    metricsSessionsEmpty: "No sessions yet.",
    metricsPair: "Pair",
    metricsStatus: "Status",
    metricsReconnects: "Reconnects",
    metricsInbound: "Inbound msg/s",
    metricsOutbound: "Outbound msg/s",
    metricsErrors: "Errors in the last minute",
    metricsDoActive: "Server active (s)",
    connectionLost: "Lost the connection to the room.",
    reconnect: "Reconnect",

    errorTitle: "Something went wrong",
    errNameRequired: "Enter a display name.",
    errConsentRequired: "Consent is required before joining.",
    errLangRequired: "Choose your language.",
    errCodeRequired: "Enter the room code.",
    errRoleRequired: "Choose your role.",
    errNetwork: "Could not reach the server.",
    errUnknownRoom: "No room has this code.",
    errInvalidBody: "The submitted data is invalid.",
    errUnsupportedLanguage: "That language is not supported yet.",
    errCreationDisabled: "Room creation is temporarily disabled.",
    errTeacherTaken: "This room already has a teacher.",
    errRoomFull: "This room is full.",
    errUnauthorized: "The join token expired or is not valid.",
    errNotYourFloor: "You do not hold the floor.",
    errRateLimited: "Too many messages, slow down a little.",
    errFrameTooLarge: "Audio frame too large.",
    errSessionDegraded:
      "The translation-session cap was reached, so some languages have no audio.",
    errRoomClosed: "The room was closed.",
    errServer: "Server error.",
    errUnknown: "Unknown error.",

    langNameAr: "Arabic",
    langNameEn: "English",
    langNameFr: "French",
    langNameEs: "Spanish",

    backHome: "Back to home",
  },

  fr: {
    appTitle: "Fitra",
    appTagline: "Laboratoire de traduction vocale en direct",
    uiLangLabel: "Langue de l’interface",
    navHome: "Accueil",
    navCreate: "Créer un salon",
    navJoin: "Rejoindre",

    homeLead:
      "Un enseignant parle sa langue, des élèves à l’étranger entendent la leur — traduction vocale en direct, rien n’est enregistré.",
    homeCreateCta: "Créer un salon",
    homeJoinCta: "Rejoindre avec un code",
    homeStep1Title: "1 — L’enseignant crée un salon",
    homeStep1Body:
      "Choisissez votre langue et celles de la classe, et obtenez un code court à partager.",
    homeStep2Title: "2 — Les élèves rejoignent avec le code",
    homeStep2Body:
      "Ils saisissent le code, un nom affiché et leur langue, puis acceptent l’avis de confidentialité avant l’activation du micro.",
    homeFloorTitle: "Règle de la parole",
    homeFloorBody:
      "Une seule personne parle à la fois. L’élève lève la main, l’enseignant accorde ou refuse, et peut retirer la parole à tout moment.",

    createTitle: "Créer un salon",
    createLead: "Réglez les options, puis partagez le code avec vos élèves.",
    createConsentLead:
      "Avant de créer le salon, confirmez avoir informé chaque élève de l’avis de confidentialité et que les tuteurs des mineurs ont accepté.",
    createDoneTitle: "Prêt",
    createDoneLead:
      "Partagez ce code avec vos élèves. Le jeton d’accès expire 10 minutes après son émission.",
    createCodeLabel: "Code du salon",
    createShareHint: "Recopiez le code tel quel — lettres et chiffres uniquement.",
    createEnterRoom: "Entrer dans le salon comme enseignant",

    joinTitle: "Rejoindre un salon",
    joinLead: "Saisissez le code, votre nom affiché, votre rôle et votre langue.",
    joinBlockedNotice:
      "Le consentement est obligatoire avant l’activation du micro. Lisez l’avis puis acceptez pour continuer.",
    joinRoleHint: "Un salon ne compte qu’un seul enseignant.",

    fieldNameLabel: "Nom affiché",
    fieldNamePlaceholder: "ex. Layla",
    fieldTeacherLangLabel: "Langue de l’enseignant",
    fieldRoomCodeLabel: "Code du salon",
    fieldRoomCodePlaceholder: "ex. K7M2QX",
    fieldRoleLabel: "Rôle",
    fieldLangLabel: "Ma langue (écoute + parole)",

    toggleAutoGrantLabel: "Accorder la parole automatiquement",
    toggleAutoGrantHelp:
      "Désactivé par défaut. Activé, une main levée est accordée immédiatement.",
    toggleClassmatesLabel: "Les élèves s’entendent entre eux",
    toggleClassmatesHelp:
      "Activé par défaut. Désactivé, seul l’enseignant entend l’élève qui parle.",
    consentConfirmLabel:
      "Je confirme avoir informé tous les élèves de l’avis de confidentialité et que les tuteurs des mineurs ont consenti",

    consentTitle: "Avis de consentement et de confidentialité",
    consentIntro: "Avant l’activation du micro, veuillez lire attentivement :",
    consentInArabic: "En arabe",
    consentInYourLang: "Dans votre langue",
    consentTerms: "Conditions d’utilisation de Gemini et sa politique de données",
    consentAccept: "J’accepte et je continue",
    consentDecline: "Je n’accepte pas",
    consentDeclinedNotice:
      "Impossible de continuer sans consentement. Vous pouvez rouvrir l’avis à tout moment.",
    consentAi:
      "Votre voix est traduite en direct par un service d’IA (Google Gemini). L’audio transite par le serveur et n’y est pas stocké.",
    consentFreeTier:
      "Sur l’offre gratuite de test, Google peut utiliser le contenu envoyé pour améliorer ses produits et des réviseurs humains peuvent le lire. La production utilise l’offre payante, où le contenu n’est pas utilisé pour l’entraînement.",
    consentNoRecording:
      "Fitra n’enregistre aucune session audio : ni sur le serveur, ni dans le navigateur.",
    consentLeave:
      "Vous pouvez quitter le salon à tout moment d’un clic, et rien n’est conservé ensuite.",
    consentMinors:
      "Si l’élève est mineur, cet avis s’adresse au parent ou au tuteur, qui doit accepter avant la participation.",

    roleTeacher: "Enseignant",
    roleStudent: "Élève",

    submitCreate: "Créer le salon",
    submitJoin: "Rejoindre le salon",
    submitting: "En cours…",

    roomTitle: "Salon",
    roomLeave: "Quitter le salon",
    floorIdle: "Le salon est silencieux",
    floorTeacher: "L’enseignant parle",
    floorStudent: "{name} parle",
    floorYours: "Vous avez la parole",
    floorNone: "Personne ne parle",
    floorWaiting: "En attente d’un orateur",
    raiseHand: "Lever la main",
    lowerHand: "Baisser la main",
    handRaisedBadge: "Main levée",
    handsSummaryNone: "Aucune main levée",
    handsSummaryOne: "Une main levée",
    handsSummaryMany: "{count} mains levées",
    revokeFloor: "Retirer la parole",
    grantFloor: "Accorder la parole",
    denyRequest: "Refuser",
    rosterTitle: "Participants",
    rosterEmpty: "Personne pour l’instant.",
    rosterYou: "Vous",
    micLabel: "Tester le microphone",
    micOn: "Microphone activé",
    micOff: "Microphone coupé",
    micHint:
      "Touchez pour tester le micro. Le son ne démarre qu’après un clic explicite de votre part.",
    micDeniedHint:
      "L’autorisation du micro a été refusée. Activez-la dans votre navigateur puis réessayez.",
    micDeviceLostHint:
      "Le micro choisi n’est plus disponible ; le son passe sur le micro par défaut.",
    headphonesHint:
      "Utilisez un casque pour éviter l’écho et les voix mélangées.",
    generatedVoiceNote:
      "La voix traduite est générée par IA, pas la voix de l’orateur.",
    testDeploymentBadge:
      "Déploiement de test — traduit par IA, non enregistré par nos soins",
    captionsTitle: "Sous-titres",
    captionsEmpty: "Ce moteur ne fournit pas encore de transcription.",
    captionsInputLabel: "Orateur",
    captionsOutputLabel: "Traduction",
    sessionsTitle: "Sessions de traduction",
    sessionsEmpty: "Aucune session pour l’instant.",
    statusConnecting: "Connexion",
    statusLive: "En direct",
    statusReconnecting: "Reconnexion",
    statusFailed: "Échec",
    statusDegraded: "Dégradé",
    metricsPlaceholder: "Le panneau de métriques apparaîtra ici.",
    metricsTitle: "Métriques en direct",
    metricsWaiting: "En attente du premier rapport du serveur.",
    metricsLatency: "Latence de bout en bout",
    metricsLatencySamples: "{count} échantillons",
    metricsLatencySource: "Estimation locale depuis ce navigateur",
    metricsLatencyServer: "Rapporté par le serveur",
    metricsLatencyEmpty: "En attente du premier fragment traduit",
    metricsSessionsTitle: "Sessions de traduction",
    metricsSessionsEmpty: "Aucune session pour l’instant.",
    metricsPair: "Paire",
    metricsStatus: "État",
    metricsReconnects: "Reconnexions",
    metricsInbound: "Messages entrants/s",
    metricsOutbound: "Messages sortants/s",
    metricsErrors: "Erreurs sur la dernière minute",
    metricsDoActive: "Serveur actif (s)",
    connectionLost: "Connexion au salon perdue.",
    reconnect: "Se reconnecter",

    errorTitle: "Une erreur est survenue",
    errNameRequired: "Saisissez un nom affiché.",
    errConsentRequired: "Le consentement est obligatoire avant de rejoindre.",
    errLangRequired: "Choisissez votre langue.",
    errCodeRequired: "Saisissez le code du salon.",
    errRoleRequired: "Choisissez votre rôle.",
    errNetwork: "Impossible de joindre le serveur.",
    errUnknownRoom: "Aucun salon ne porte ce code.",
    errInvalidBody: "Les données envoyées sont invalides.",
    errUnsupportedLanguage: "Cette langue n’est pas encore prise en charge.",
    errCreationDisabled: "La création de salons est temporairement désactivée.",
    errTeacherTaken: "Ce salon a déjà un enseignant.",
    errRoomFull: "Ce salon est complet.",
    errUnauthorized: "Le jeton d’accès a expiré ou n’est pas valide.",
    errNotYourFloor: "Vous n’avez pas la parole.",
    errRateLimited: "Trop de messages, ralentissez un peu.",
    errFrameTooLarge: "Trame audio trop volumineuse.",
    errSessionDegraded:
      "Le plafond de sessions de traduction est atteint : certaines langues n’ont pas d’audio.",
    errRoomClosed: "Le salon a été fermé.",
    errServer: "Erreur du serveur.",
    errUnknown: "Erreur inconnue.",

    langNameAr: "Arabe",
    langNameEn: "Anglais",
    langNameFr: "Français",
    langNameEs: "Espagnol",

    backHome: "Retour à l’accueil",
  },

  es: {
    appTitle: "Fitra",
    appTagline: "Laboratorio de traducción de voz en vivo",
    uiLangLabel: "Idioma de la interfaz",
    navHome: "Inicio",
    navCreate: "Crear sala",
    navJoin: "Unirse",

    homeLead:
      "Un docente habla su idioma y el alumnado en el extranjero escucha el suyo: traducción de voz en vivo, sin grabar nada.",
    homeCreateCta: "Crear una sala",
    homeJoinCta: "Unirse con un código",
    homeStep1Title: "1 — El docente crea una sala",
    homeStep1Body:
      "Elige tu idioma y los de la clase, y obtienes un código breve para compartir.",
    homeStep2Title: "2 — El alumnado se une con el código",
    homeStep2Body:
      "Escriben el código, un nombre visible y su idioma, y aceptan el aviso de privacidad antes de activar el micrófono.",
    homeFloorTitle: "Regla de turnos",
    homeFloorBody:
      "Solo una persona habla a la vez. El alumno levanta la mano, el docente concede o deniega, y puede retirar el turno en cualquier momento.",

    createTitle: "Crear una sala",
    createLead: "Ajusta las opciones y comparte el código con tu alumnado.",
    createConsentLead:
      "Antes de crear la sala, confirma que informaste a todo el alumnado del aviso de privacidad y que las familias de los menores han aceptado.",
    createDoneTitle: "Listo",
    createDoneLead:
      "Comparte este código con tu alumnado. El token de acceso caduca 10 minutos después de emitirse.",
    createCodeLabel: "Código de la sala",
    createShareHint: "Escribe el código tal cual: solo letras y números.",
    createEnterRoom: "Entrar en la sala como docente",

    joinTitle: "Unirse a una sala",
    joinLead: "Introduce el código, tu nombre visible, tu rol y tu idioma.",
    joinBlockedNotice:
      "El consentimiento es obligatorio antes de activar el micrófono. Lee el aviso y acéptalo para continuar.",
    joinRoleHint: "Una sala tiene exactamente un docente.",

    fieldNameLabel: "Nombre visible",
    fieldNamePlaceholder: "p. ej. Layla",
    fieldTeacherLangLabel: "Idioma del docente",
    fieldRoomCodeLabel: "Código de la sala",
    fieldRoomCodePlaceholder: "p. ej. K7M2QX",
    fieldRoleLabel: "Rol",
    fieldLangLabel: "Mi idioma (escuchar + hablar)",

    toggleAutoGrantLabel: "Conceder el turno automáticamente",
    toggleAutoGrantHelp:
      "Desactivado por defecto. Activado, una mano levantada se concede al instante.",
    toggleClassmatesLabel: "El alumnado se escucha entre sí",
    toggleClassmatesHelp:
      "Activado por defecto. Desactivado, solo el docente oye al alumno que habla.",
    consentConfirmLabel:
      "Confirmo que he informado a todo el alumnado del aviso de privacidad y que las familias de los menores han consentido",

    consentTitle: "Aviso de consentimiento y privacidad",
    consentIntro: "Antes de activar el micrófono, lee con atención:",
    consentInArabic: "En árabe",
    consentInYourLang: "En tu idioma",
    consentTerms: "Condiciones de uso de Gemini y su política de datos",
    consentAccept: "Acepto y continúo",
    consentDecline: "No acepto",
    consentDeclinedNotice:
      "No se puede continuar sin consentimiento. Puedes volver a abrir el aviso cuando quieras.",
    consentAi:
      "Tu voz se traduce en vivo mediante un servicio de IA (Google Gemini). El audio pasa por el servidor y no se guarda allí.",
    consentFreeTier:
      "En el nivel gratuito de prueba, Google puede usar el contenido enviado para mejorar sus productos y revisores humanos pueden leerlo. La producción usa el nivel de pago, donde el contenido no se usa para entrenar.",
    consentNoRecording:
      "Fitra no graba ninguna sesión de audio: ni en el servidor ni en el navegador.",
    consentLeave:
      "Puedes salir de la sala cuando quieras con un botón, y no queda nada guardado.",
    consentMinors:
      "Si el alumno es menor de edad, este aviso se dirige a la madre, el padre o su tutor, quien debe aceptar antes de que participe.",

    roleTeacher: "Docente",
    roleStudent: "Alumno",

    submitCreate: "Crear la sala",
    submitJoin: "Entrar en la sala",
    submitting: "Un momento…",

    roomTitle: "Sala",
    roomLeave: "Salir de la sala",
    floorIdle: "La sala está en silencio",
    floorTeacher: "El docente está hablando",
    floorStudent: "{name} está hablando",
    floorYours: "Tienes el turno",
    floorNone: "Nadie está hablando",
    floorWaiting: "Esperando a quien hable",
    raiseHand: "Levantar la mano",
    lowerHand: "Bajar la mano",
    handRaisedBadge: "Mano levantada",
    handsSummaryNone: "Ninguna mano levantada",
    handsSummaryOne: "Una mano levantada",
    handsSummaryMany: "{count} manos levantadas",
    revokeFloor: "Retirar el turno",
    grantFloor: "Conceder el turno",
    denyRequest: "Denegar",
    rosterTitle: "Participantes",
    rosterEmpty: "Todavía no hay nadie.",
    rosterYou: "Tú",
    micLabel: "Probar el micrófono",
    micOn: "Micrófono activo",
    micOff: "Micrófono silenciado",
    micHint:
      "Toca para probar el micrófono. El sonido solo arranca tras un clic explícito tuyo.",
    micDeniedHint:
      "Se denegó el permiso del micrófono. Actívalo en el navegador y vuelve a intentarlo.",
    micDeviceLostHint:
      "El micrófono elegido ya no está, así que el audio pasó al micrófono predeterminado.",
    headphonesHint:
      "Usa auriculares para evitar el eco y las voces mezcladas.",
    generatedVoiceNote:
      "La voz traducida la genera la IA, no es la voz del hablante.",
    testDeploymentBadge:
      "Despliegue de prueba — traducido por IA, no lo grabamos",
    captionsTitle: "Subtítulos",
    captionsEmpty: "Este motor todavía no ofrece transcripción.",
    captionsInputLabel: "Ponente",
    captionsOutputLabel: "Traducción",
    sessionsTitle: "Sesiones de traducción",
    sessionsEmpty: "Aún no hay sesiones.",
    statusConnecting: "Conectando",
    statusLive: "En vivo",
    statusReconnecting: "Reconectando",
    statusFailed: "Falló",
    statusDegraded: "Degradado",
    metricsPlaceholder: "El panel de métricas aparecerá aquí.",
    metricsTitle: "Métricas en vivo",
    metricsWaiting: "Esperando el primer informe del servidor.",
    metricsLatency: "Latencia de extremo a extremo",
    metricsLatencySamples: "{count} muestras",
    metricsLatencySource: "Estimación local desde este navegador",
    metricsLatencyServer: "Informado por el servidor",
    metricsLatencyEmpty: "Esperando el primer fragmento traducido",
    metricsSessionsTitle: "Sesiones de traducción",
    metricsSessionsEmpty: "Aún no hay sesiones.",
    metricsPair: "Par",
    metricsStatus: "Estado",
    metricsReconnects: "Reconexiones",
    metricsInbound: "Mensajes entrantes/s",
    metricsOutbound: "Mensajes salientes/s",
    metricsErrors: "Errores en el último minuto",
    metricsDoActive: "Servidor activo (s)",
    connectionLost: "Se perdió la conexión con la sala.",
    reconnect: "Reconectar",

    errorTitle: "Algo ha salido mal",
    errNameRequired: "Escribe un nombre visible.",
    errConsentRequired: "El consentimiento es obligatorio antes de entrar.",
    errLangRequired: "Elige tu idioma.",
    errCodeRequired: "Escribe el código de la sala.",
    errRoleRequired: "Elige tu rol.",
    errNetwork: "No se pudo contactar con el servidor.",
    errUnknownRoom: "No existe ninguna sala con ese código.",
    errInvalidBody: "Los datos enviados no son válidos.",
    errUnsupportedLanguage: "Ese idioma aún no es compatible.",
    errCreationDisabled: "La creación de salas está desactivada temporalmente.",
    errTeacherTaken: "Esta sala ya tiene un docente.",
    errRoomFull: "Esta sala está llena.",
    errUnauthorized: "El token de acceso caducó o no es válido.",
    errNotYourFloor: "No tienes el turno.",
    errRateLimited: "Demasiados mensajes, baja un poco el ritmo.",
    errFrameTooLarge: "Trama de audio demasiado grande.",
    errSessionDegraded:
      "Se alcanzó el límite de sesiones de traducción: algunos idiomas se quedan sin audio.",
    errRoomClosed: "La sala se cerró.",
    errServer: "Error del servidor.",
    errUnknown: "Error desconocido.",

    langNameAr: "Árabe",
    langNameEn: "Inglés",
    langNameFr: "Francés",
    langNameEs: "Español",

    backHome: "Volver al inicio",
  },
};

export function getStrings(lang: SupportedUiLang): UiStrings {
  return STRINGS[lang];
}

const ERROR_KEYS: Record<ErrorCode, keyof UiStrings> = {
  unauthorized: "errUnauthorized",
  "teacher-taken": "errTeacherTaken",
  "room-full": "errRoomFull",
  "unsupported-language": "errUnsupportedLanguage",
  "not-your-floor": "errNotYourFloor",
  "rate-limited": "errRateLimited",
  "frame-too-large": "errFrameTooLarge",
  "session-degraded": "errSessionDegraded",
  "room-closed": "errRoomClosed",
  "creation-disabled": "errCreationDisabled",
  "unknown-room": "errUnknownRoom",
  "invalid-body": "errInvalidBody",
  "server-misconfigured": "errServer",
  network: "errNetwork",
};

export function errorMessageKey(code: string): keyof UiStrings {
  return Object.hasOwn(ERROR_KEYS, code)
    ? ERROR_KEYS[code as ErrorCode]
    : "errUnknown";
}

export type SessionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "failed"
  | "degraded";

export function sessionStatusKey(status: SessionStatus): SessionStatusKey {
  switch (status) {
    case "connecting":
      return "statusConnecting";
    case "live":
      return "statusLive";
    case "reconnecting":
      return "statusReconnecting";
    case "failed":
      return "statusFailed";
    case "degraded":
      return "statusDegraded";
    default:
      return assertNever(status);
  }
}

const CONSENT_POINT_KEYS: readonly ConsentPointKey[] = [
  "consentAi",
  "consentFreeTier",
  "consentNoRecording",
  "consentLeave",
  "consentMinors",
];

export function consentPoints(strings: UiStrings): readonly string[] {
  return CONSENT_POINT_KEYS.map((key) => strings[key]);
}