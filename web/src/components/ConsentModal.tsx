// T-013: pre-join consent gate. Copy is normative in docs/PRIVACY.md section 2 —
// Arabic + the participant's own language, both required before the microphone
// may start (PRIVACY rule 3). Language order follows the task spec: Arabic
// first, then the participant language.

import {
  PARTICIPANT_LANGS,
  consentPoints,
  getStrings,
  isParticipantLang,
  nativeNameOf,
  type ParticipantLang,
  type SupportedUiLang,
  type UiStrings,
} from "../i18n.js";

export interface ConsentModalProps {
  readonly uiLang: SupportedUiLang;
  readonly participantLang: ParticipantLang;
  readonly outcome: "pending" | "declined";
  readonly onLanguageChange: (lang: ParticipantLang) => void;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}

function ConsentList({
  heading,
  strings,
  lang,
  testId,
}: {
  readonly heading: string;
  readonly strings: UiStrings;
  readonly lang: ParticipantLang;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <section data-testid={testId} lang={lang}>
      <h3 className="ui-section-title">{heading}</h3>
      <ul className="mt-3 space-y-3">
        {consentPoints(strings).map((point, index) => (
          <li key={index} className="flex gap-3 text-sm leading-relaxed text-ink-700">
            <span
              aria-hidden="true"
              className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500"
            />
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ConsentModal({
  uiLang,
  participantLang,
  outcome,
  onLanguageChange,
  onAccept,
  onDecline,
}: ConsentModalProps): React.JSX.Element {
  const uiStrings = getStrings(uiLang);
  const participantStrings = getStrings(participantLang);
  const showBoth = participantLang !== "ar";

  return (
    <div
      className="ui-modal-backdrop"
      role="presentation"
      data-testid="consent-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
        aria-describedby="consent-intro"
        className="ui-modal"
      >
        <header className="border-b border-paper-line bg-saffron-50 px-5 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-saffron-100 text-base text-saffron-700"
            >
              !
            </span>
            <div>
              <h2 id="consent-title" className="text-lg font-bold text-saffron-700">
                {uiStrings.consentTitle}
              </h2>
              <p id="consent-intro" className="mt-1 text-sm text-saffron-700/90">
                {uiStrings.consentIntro}
              </p>
            </div>
          </div>
        </header>

        <div className="stagger flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
          <ConsentList
            heading={uiStrings.consentInArabic}
            strings={getStrings("ar")}
            lang="ar"
            testId="consent-ar"
          />
          {showBoth && (
            <div className="border-t border-dashed border-paper-line pt-5">
              <ConsentList
                heading={uiStrings.consentInYourLang}
                strings={participantStrings}
                lang={participantLang}
                testId="consent-participant-lang"
              />
            </div>
          )}
          <p className="ui-hint">
            <a
              className="font-semibold text-brand-600 underline underline-offset-4 hover:text-brand-700"
              href="https://ai.google.dev/gemini-api/terms"
              target="_blank"
              rel="noreferrer noopener"
            >
              {uiStrings.consentTerms}
            </a>
          </p>
        </div>

        <footer className="space-y-3 border-t border-paper-line bg-paper-sunk px-5 py-4 sm:px-6">
          {outcome === "declined" && (
            <p
              className="ui-banner-danger"
              data-testid="consent-declined-notice"
              role="alert"
            >
              {uiStrings.consentDeclinedNotice}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-ink-700">
              {uiStrings.consentInYourLang}
              <select
                className="ui-select w-auto py-1.5 text-sm"
                data-testid="consent-lang"
                value={participantLang}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isParticipantLang(next)) onLanguageChange(next);
                }}
              >
                {PARTICIPANT_LANGS.map((option) => (
                  <option key={option} value={option}>
                    {nativeNameOf(option)}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="ui-btn-ghost"
                data-testid="consent-decline"
                onClick={onDecline}
              >
                {uiStrings.consentDecline}
              </button>
              <button
                type="button"
                className="ui-btn-primary"
                data-testid="consent-accept"
                onClick={onAccept}
              >
                {uiStrings.consentAccept}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}