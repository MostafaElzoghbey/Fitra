// T-013: floor state banner + the one control each role owns.
// Floor is server-authoritative (docs/FLOOR-CONTROL.md): this component only
// renders the holder the DO last broadcast and emits hints.

import type { FloorHolder, Role, RosterEntry } from "@fitra/shared";

import { fmt, type UiStrings } from "../i18n.js";

export interface FloorBarProps {
  readonly strings: UiStrings;
  readonly roster: readonly RosterEntry[];
  readonly floor: FloorHolder;
  readonly role: Role;
  readonly selfId: string | null;
  readonly handRaised: boolean;
  readonly handsUpCount: number;
  readonly micMuted: boolean;
  readonly onRaiseHand: () => void;
  readonly onLowerHand: () => void;
  readonly onRevoke: () => void;
  readonly onToggleMic: () => void;
  readonly micHint: string | null;
}

function holderName(
  roster: readonly RosterEntry[],
  holder: FloorHolder,
): string {
  if (holder.kind !== "student") return holder.kind;
  return (
    roster.find((e) => e.participantId === holder.participantId)?.name ??
    holder.participantId
  );
}

export function FloorBar({
  strings,
  roster,
  floor,
  role,
  selfId,
  handRaised,
  handsUpCount,
  micMuted,
  onRaiseHand,
  onLowerHand,
  onRevoke,
  onToggleMic,
  micHint,
}: FloorBarProps): React.JSX.Element {
  const live = floor.kind !== "none";
  const holdsFloor =
    (floor.kind === "teacher" && role === "teacher") ||
    (floor.kind === "student" && floor.participantId === selfId);

  const bannerText = (() => {
    switch (floor.kind) {
      case "none":
        return strings.floorIdle;
      case "teacher":
        return strings.floorTeacher;
      case "student":
        return fmt(strings.floorStudent, { name: holderName(roster, floor) });
      default:
        return strings.floorNone;
    }
  })();

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
          <div>
            <p className="ui-section-title">{strings.floorWaiting}</p>
            <p
              className="mt-0.5 text-xl font-bold text-ink-900"
              data-testid="floor-banner"
              data-floor={floor.kind}
              role="status"
              aria-live="polite"
            >
              {bannerText}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={micMuted ? "ui-btn-secondary" : "ui-btn-live"}
            data-testid="mic-toggle"
            aria-pressed={!micMuted}
            onClick={onToggleMic}
          >
            <span aria-hidden="true">{micMuted ? "🔇" : "🎙"}</span>
            {micMuted ? strings.micOff : strings.micOn}
          </button>

          {role === "student" &&
            (handRaised ? (
              <button
                type="button"
                className="ui-btn-secondary"
                data-testid="lower-hand"
                onClick={onLowerHand}
              >
                {strings.lowerHand}
              </button>
            ) : (
              <button
                type="button"
                className="ui-btn-live"
                data-testid="raise-hand"
                onClick={onRaiseHand}
              >
                ✋ {strings.raiseHand}
              </button>
            ))}

          {role === "teacher" && floor.kind === "student" && (
            <button
              type="button"
              className="ui-btn-danger"
              data-testid="revoke"
              onClick={onRevoke}
            >
              {strings.revokeFloor}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-paper-line bg-paper-sunk px-5 py-3">
        <p className="ui-hint" data-testid="hands-summary">
          {handsUpCount === 0
            ? strings.handsSummaryNone
            : handsUpCount === 1
              ? strings.handsSummaryOne
              : fmt(strings.handsSummaryMany, { count: handsUpCount })}
        </p>
        {holdsFloor && (
          <p className="ui-chip-live" data-testid="floor-yours">
            {strings.floorYours}
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