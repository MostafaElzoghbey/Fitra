// T-013: room creation. Produces the shareable room code (SPEC FR-002) and
// records the room config the teacher chose (FR-005 teacher language, FR-012
// autoGrant, FR-023 classmatesHearStudent, PRIVACY rule 3 consent checkbox).

import { useState } from "react";

import {
  PARTICIPANT_LANGS,
  getStrings,
  isParticipantLang,
  nativeNameOf,
  type ParticipantLang,
  type UiStrings,
} from "../i18n.js";
import { useUiLang } from "../uiLang.js";
import { createRoom } from "../net/api.js";
import { joinHash, navigate } from "../router.js";

export function Create(): React.JSX.Element {
  const { lang } = useUiLang();
  const strings = getStrings(lang);

  const [teacherName, setTeacherName] = useState("");
  const [teacherLang, setTeacherLang] = useState<ParticipantLang>("ar");
  const [autoGrant, setAutoGrant] = useState(false);
  const [classmatesHearStudent, setClassmatesHearStudent] = useState(true);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<keyof UiStrings | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorKey(null);
    if (teacherName.trim() === "") {
      setErrorKey("errNameRequired");
      return;
    }
    if (!consentConfirmed) {
      setErrorKey("errConsentRequired");
      return;
    }
    setBusy(true);
    const result = await createRoom({
      teacherName: teacherName.trim(),
      teacherLang,
      autoGrant,
      classmatesHearStudent,
      consentConfirmed,
    });
    setBusy(false);
    if (result.ok) {
      setCode(result.value);
      return;
    }
    setErrorKey(result.messageKey);
  }

  if (code !== null) {
    return (
      <main className="ui-page-narrow">
        <section
          className="ui-card animate-rise-in p-6 text-center sm:p-8"
          data-testid="create-result"
        >
          <p className="ui-chip-brand mx-auto">{strings.createDoneTitle}</p>
          <p className="ui-subtitle mx-auto mt-4 max-w-md">{strings.createDoneLead}</p>
          <p
            className="ui-code mt-6 select-all rounded-md border border-brand-100 bg-brand-50 px-4 py-4"
            data-testid="room-code"
          >
            {code}
          </p>
          <p className="ui-hint mt-3">{strings.createShareHint}</p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              className="ui-btn-primary"
              data-testid="enter-room"
              onClick={() =>
                navigate(joinHash({ code, role: "teacher", lang: teacherLang }))
              }
            >
              {strings.createEnterRoom}
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="ui-page-narrow">
      <header className="animate-rise-in">
        <h1 className="ui-title">{strings.createTitle}</h1>
        <p className="ui-subtitle mt-3">{strings.createLead}</p>
      </header>

      <form
        className="ui-card stagger mt-8 space-y-6 p-5 sm:p-6"
        onSubmit={onSubmit}
        noValidate
      >
        <div>
          <label className="ui-label" htmlFor="teacher-name">
            {strings.fieldNameLabel}
          </label>
          <input
            id="teacher-name"
            className="ui-input mt-2"
            data-testid="teacher-name"
            value={teacherName}
            maxLength={64}
            autoComplete="name"
            placeholder={strings.fieldNamePlaceholder}
            onChange={(event) => setTeacherName(event.target.value)}
          />
        </div>

        <div>
          <label className="ui-label" htmlFor="teacher-lang">
            {strings.fieldTeacherLangLabel}
          </label>
          <select
            id="teacher-lang"
            className="ui-select mt-2"
            data-testid="teacher-lang"
            value={teacherLang}
            onChange={(event) => {
              const next = event.target.value;
              if (isParticipantLang(next)) setTeacherLang(next);
            }}
          >
            {PARTICIPANT_LANGS.map((option) => (
              <option key={option} value={option}>
                {nativeNameOf(option)}
              </option>
            ))}
          </select>
        </div>

        <ToggleRow
          testId="toggle-auto-grant"
          checked={autoGrant}
          label={strings.toggleAutoGrantLabel}
          help={strings.toggleAutoGrantHelp}
          onChange={setAutoGrant}
        />
        <ToggleRow
          testId="toggle-classmates"
          checked={classmatesHearStudent}
          label={strings.toggleClassmatesLabel}
          help={strings.toggleClassmatesHelp}
          onChange={setClassmatesHearStudent}
        />

        <div>
          <p className="ui-banner-warn mb-3">{strings.createConsentLead}</p>
          <label className="ui-check" data-checked={consentConfirmed} data-testid="consent-confirm">
            <input
              type="checkbox"
              checked={consentConfirmed}
              onChange={(event) => setConsentConfirmed(event.target.checked)}
            />
            <span className="text-sm leading-relaxed text-ink-800">
              {strings.consentConfirmLabel}
            </span>
          </label>
        </div>

        {errorKey !== null && (
          <p className="ui-banner-danger" role="alert" data-testid="create-error">
            {strings[errorKey]}
          </p>
        )}

        <button
          type="submit"
          className="ui-btn-primary w-full"
          data-testid="create-room"
          disabled={busy}
        >
          {busy ? strings.submitting : strings.submitCreate}
        </button>
      </form>
    </main>
  );
}

function ToggleRow({
  testId,
  checked,
  label,
  help,
  onChange,
}: {
  readonly testId: string;
  readonly checked: boolean;
  readonly label: string;
  readonly help: string;
  readonly onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="ui-check" data-checked={checked} data-testid={testId}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block font-semibold text-ink-800">{label}</span>
        <span className="mt-1 block text-sm leading-relaxed text-ink-500">{help}</span>
      </span>
    </label>
  );
}