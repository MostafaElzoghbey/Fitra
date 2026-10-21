// T-013: join form. PRIVACY rule 3 — the consent notice is a blocking gate: the
// submit button stays disabled until it is accepted, and the notice is shown in
// Arabic plus the participant's own language.

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
import { ConsentModal } from "../components/ConsentModal.js";
import { joinRoom } from "../net/api.js";
import { navigate, roomHash, type Role } from "../router.js";

type ConsentState = "pending" | "accepted" | "declined";

export interface JoinProps {
  readonly prefillCode: string | null;
  readonly prefillRole: Role;
  readonly prefillLang: ParticipantLang | null;
}

export function Join({
  prefillCode,
  prefillRole,
  prefillLang,
}: JoinProps): React.JSX.Element {
  const { lang } = useUiLang();
  const strings = getStrings(lang);

  const [code, setCode] = useState(prefillCode ?? "");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(prefillRole);
  const [participantLang, setParticipantLang] = useState<ParticipantLang>(
    prefillLang ?? "ar",
  );
  const [consent, setConsent] = useState<ConsentState>("pending");
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<keyof UiStrings | null>(null);

  const consentSatisfied = consent === "accepted";

  async function onSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setErrorKey(null);
    const trimmedCode = code.trim().toUpperCase();
    const trimmedName = name.trim();
    if (trimmedCode === "") {
      setErrorKey("errCodeRequired");
      return;
    }
    if (trimmedName === "") {
      setErrorKey("errNameRequired");
      return;
    }
    if (!consentSatisfied) {
      setErrorKey("errConsentRequired");
      return;
    }
    setBusy(true);
    const result = await joinRoom(trimmedCode, {
      name: trimmedName,
      role,
      lang: participantLang,
    });
    setBusy(false);
    if (!result.ok) {
      setErrorKey(result.messageKey);
      return;
    }
    navigate(
      roomHash({
        code: trimmedCode,
        token: result.value,
        role,
        lang: participantLang,
        ui: lang,
        name: trimmedName,
      }),
    );
  }

  return (
    <>
      <main className="ui-page-narrow">
        <header className="animate-rise-in">
          <h1 className="ui-title">{strings.joinTitle}</h1>
          <p className="ui-subtitle mt-3">{strings.joinLead}</p>
        </header>

        {!consentSatisfied && (
          <p
            className="ui-banner-warn mt-6"
            role="status"
            data-testid="join-blocked"
          >
            {strings.joinBlockedNotice}
          </p>
        )}

        <form
          className="ui-card stagger mt-6 space-y-6 p-5 sm:p-6"
          onSubmit={onSubmit}
          noValidate
        >
          <div>
            <label className="ui-label" htmlFor="room-code">
              {strings.fieldRoomCodeLabel}
            </label>
            <input
              id="room-code"
              className="ui-input ui-code mt-2 text-base tracking-[0.2em]"
              data-testid="room-code-input"
              value={code}
              maxLength={10}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              placeholder={strings.fieldRoomCodePlaceholder}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
          </div>

          <div>
            <label className="ui-label" htmlFor="display-name">
              {strings.fieldNameLabel}
            </label>
            <input
              id="display-name"
              className="ui-input mt-2"
              data-testid="display-name"
              value={name}
              maxLength={64}
              autoComplete="name"
              placeholder={strings.fieldNamePlaceholder}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <fieldset>
            <legend className="ui-label">{strings.fieldRoleLabel}</legend>
            <div
              className="mt-2 grid gap-3 sm:grid-cols-2"
              data-testid="role-group"
            >
              {(["teacher", "student"] as const).map((option) => (
                <label
                  key={option}
                  className="ui-check"
                  data-checked={role === option}
                >
                  <input
                    type="radio"
                    name="role"
                    value={option}
                    checked={role === option}
                    onChange={() => setRole(option)}
                  />
                  <span className="font-semibold text-ink-800">
                    {option === "teacher"
                      ? strings.roleTeacher
                      : strings.roleStudent}
                  </span>
                </label>
              ))}
            </div>
            <p className="ui-hint mt-2">{strings.joinRoleHint}</p>
          </fieldset>

          <div>
            <label className="ui-label" htmlFor="participant-lang">
              {strings.fieldLangLabel}
            </label>
            <select
              id="participant-lang"
              className="ui-select mt-2"
              data-testid="participant-lang"
              value={participantLang}
              onChange={(event) => {
                const next = event.target.value;
                if (isParticipantLang(next)) setParticipantLang(next);
              }}
            >
              {PARTICIPANT_LANGS.map((option) => (
                <option key={option} value={option}>
                  {nativeNameOf(option)}
                </option>
              ))}
            </select>
          </div>

          {errorKey !== null && (
            <p
              className="ui-banner-danger"
              role="alert"
              data-testid="join-error"
            >
              {strings[errorKey]}
            </p>
          )}

          <button
            type="submit"
            className="ui-btn-primary w-full"
            data-testid="join-room"
            disabled={busy || !consentSatisfied}
            aria-disabled={busy || !consentSatisfied}
          >
            {busy ? strings.submitting : strings.submitJoin}
          </button>
        </form>
      </main>

      {consent !== "accepted" && (
        <ConsentModal
          uiLang={lang}
          participantLang={participantLang}
          outcome={consent === "declined" ? "declined" : "pending"}
          onLanguageChange={setParticipantLang}
          onAccept={() => setConsent("accepted")}
          onDecline={() => setConsent("declined")}
        />
      )}
    </>
  );
}
