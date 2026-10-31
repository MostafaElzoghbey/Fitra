// T-013: mic state banner + the controls each role owns.
// Mic control is server-authoritative (docs/MIC-CONTROL.md): this component
// only renders the roster state the DO last broadcast and emits hints.

import type { Role, RosterEntry } from "@fitra/shared";

import { fmt, type UiStrings } from "../i18n.js";

export interface MicBarProps {
  readonly strings: UiStrings;
  readonly roster: readonly RosterEntry[];
  readonly role: Role;
  readonly selfId: string | null;
  readonly micHint: string | null;
  readonly onToggleMic: () => void;
  readonly onMuteAll: () => void;
  readonly onUnmuteAll: () => void;
}

export function MicBar({
  strings,
  roster,
  role,
  selfId,
  micHint,
  onToggleMic,
  onMuteAll,
  onUnmuteAll,
}: MicBarProps): React.JSX.Element {
  const self =
    selfId === null ? undefined : roster.find((e) => e.participantId === selfId);
  const selfMicOpen = self?.micOpen ?? false;
  const selfForced = self?.forcedMuted ?? false;
  const speakers = roster.filter((e) => e.micOpen);
  const live = speakers.length > 0;
  const bannerText =
    speakers.length === 0
      ? strings.micBannerIdle
      : fmt(strings.micBannerSpeaking, {
          names: speakers
            .map((e) =>
              e.participantId === selfId
                ? `${e.name} (${strings.rosterYou})`
                : e.name,
            )
            .join(", "),
        });

  return (
    <section
      className={`ui-card overflow-hidden ${live ? "ui-live-underline shadow-live" : ""}`}
      aria-label={strings.roomTitle}
    >
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className={live ? "ui-dot-live animate-pulse-live" : "ui-dot-idle"}
          />
          <p
            className="text-xl font-bold text-ink-900"
            data-testid="mic-banner"
            data-speaking={JSON.stringify(speakers.map((e) => e.participantIndex))}
            role="status"
            aria-live="polite"
          >
            {bannerText}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={selfMicOpen ? "ui-btn-live" : "ui-btn-secondary"}
            data-testid="mic-toggle"
            data-forced={String(selfForced)}
            aria-pressed={selfMicOpen}
            onClick={onToggleMic}
          >
            <span aria-hidden="true">{selfMicOpen ? "🎙" : "🔇"}</span>
            {selfMicOpen ? strings.micOn : strings.micOff}
          </button>

          {role === "teacher" && (
            <>
              <button
                type="button"
                className="ui-btn-secondary"
                data-testid="mute-all"
                onClick={onMuteAll}
              >
                {strings.muteAllLabel}
              </button>
              <button
                type="button"
                className="ui-btn-secondary"
                data-testid="unmute-all"
                onClick={onUnmuteAll}
              >
                {strings.unmuteAllLabel}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-paper-line bg-paper-sunk px-5 py-3">
        {selfForced && (
          <p className="ui-chip-live" data-testid="forced-muted-notice">
            {strings.forcedMutedNotice}
          </p>
        )}
        {micHint !== null && (
          <p className="ui-hint w-full text-danger-500" data-testid="mic-hint">
            {micHint}
          </p>
        )}
      </div>
    </section>
  );
}
