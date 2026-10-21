// T-013: roster + the teacher's hand queue. The DO is authoritative, so these
// rows render `raised`/`floor` exactly as last broadcast — no local optimism.

import type { FloorHolder, Role, RosterEntry } from "@fitra/shared";

import {
  isParticipantLang,
  nativeNameOf,
  type ParticipantLang,
  type UiStrings,
} from "../i18n.js";

export interface RosterProps {
  readonly strings: UiStrings;
  readonly roster: readonly RosterEntry[];
  readonly raised: readonly string[];
  readonly floor: FloorHolder;
  readonly role: Role;
  readonly selfId: string | null;
  readonly onGrant: (participantId: string) => void;
  readonly onDeny: (participantId: string) => void;
}

function langLabel(strings: UiStrings, lang: string): string {
  if (!isParticipantLang(lang)) return lang;
  const native: ParticipantLang = lang;
  switch (native) {
    case "ar":
      return strings.langNameAr;
    case "en":
      return strings.langNameEn;
    case "fr":
      return strings.langNameFr;
    case "es":
      return strings.langNameEs;
    default:
      return nativeNameOf(native);
  }
}

export function Roster({
  strings,
  roster,
  raised,
  floor,
  role,
  selfId,
  onGrant,
  onDeny,
}: RosterProps): React.JSX.Element {
  const isTeacher = role === "teacher";

  return (
    <section className="ui-card" aria-label={strings.rosterTitle}>
      <header className="flex items-center justify-between gap-3 border-b border-paper-line px-4 py-3">
        <h2 className="ui-section-title">{strings.rosterTitle}</h2>
        <span className="ui-chip-neutral" data-testid="roster-count">
          {roster.length}
        </span>
      </header>

      {roster.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-500" data-testid="roster-empty">
          {strings.rosterEmpty}
        </p>
      ) : (
        <ul data-testid="roster">
          {roster.map((entry) => {
            const handRaised = raised.includes(entry.participantId);
            const holdsFloor =
              (floor.kind === "student" && floor.participantId === entry.participantId) ||
              (floor.kind === "teacher" && entry.role === "teacher");
            const isSelf = entry.participantId === selfId;

            return (
              <li
                key={entry.participantId}
                className="ui-roster-row"
                data-testid={`roster-row-${entry.participantId}`}
                data-role={entry.role}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={holdsFloor ? "ui-dot-live animate-pulse-live" : "ui-dot-idle"}
                  />
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-ink-900">
                      {entry.name}
                      {isSelf && (
                        <span className="ms-2 text-xs font-normal text-brand-600">
                          ({strings.rosterYou})
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {entry.role === "teacher" ? strings.roleTeacher : strings.roleStudent}
                      {" · "}
                      {langLabel(strings, entry.lang)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {handRaised && (
                    <span className="ui-chip-live" data-testid={`hand-raised-${entry.participantId}`}>
                      ✋ {strings.handRaisedBadge}
                    </span>
                  )}
                  {isTeacher && entry.role === "student" && handRaised && !holdsFloor && (
                    <>
                      <button
                        type="button"
                        className="ui-btn-secondary ui-btn-sm"
                        data-testid={`grant-${entry.participantId}`}
                        onClick={() => onGrant(entry.participantId)}
                      >
                        {strings.grantFloor}
                      </button>
                      <button
                        type="button"
                        className="ui-btn-ghost ui-btn-sm"
                        data-testid={`deny-${entry.participantId}`}
                        onClick={() => onDeny(entry.participantId)}
                      >
                        {strings.denyRequest}
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}