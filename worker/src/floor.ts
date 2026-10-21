// T-003: pure floor-control state machine (docs/FLOOR-CONTROL.md).
//
// Pure reducer: NO socket I/O, NO storage, NO timers. The ClassRoom DO (T-007)
// calls applyFloorEvent from webSocketMessage handlers, broadcasts the
// returned `broadcasts` over its WebSockets, and translates `effects` into
// TranslationProvider session actions:
//
//   releaseSessionsFor pid -> release sessions sourcing pid
//   releaseAllSessions      -> release every translation session
//   pauseTranslation        -> stop sourcing (teacher gone); keep sockets
//   resumeTranslation       -> allow sourcing again (teacher rejoined)
//   ensureSession source    -> lazily ensure a session sourcing `source`
//
// Absent-grant rule: this module has no membership roster, so "absent" means
// "not in the raised-hands queue and not the current holder". T-007 grants
// from the hands queue (manual grant UI lists raised hands), so a grant for
// any other pid is treated as absent and rejected with `grant-absent`.

export type FloorHolder =
  | { kind: "none" }
  | { kind: "teacher" }
  | { kind: "student"; participantId: string };

export interface FloorState {
  holder: FloorHolder;
  /** FIFO queue of raised hands (participantIds), arrival order. */
  raised: string[];
  autoGrant: boolean;
  teacherConnected: boolean;
}

export type FloorEvent =
  | { type: "teacherStart" }
  | { type: "teacherStop" }
  | { type: "grant"; participantId: string }
  | { type: "deny"; participantId: string }
  | { type: "revoke" }
  | { type: "raiseHand"; participantId: string }
  | { type: "lowerHand"; participantId: string }
  | { type: "speakingStop"; participantId: string }
  | { type: "audioFrame"; participantId: string; isTeacher: boolean }
  | {
      type: "participantDisconnect";
      participantId: string;
      isTeacher: boolean;
    }
  | { type: "teacherJoin" }
  | { type: "teacherRejoin" };

export type FloorBroadcast =
  | { type: "floor-changed"; floor: FloorHolder; reason: string }
  | { type: "hands"; raised: string[] }
  | { type: "error"; code: string; participantId?: string; to?: string };

export type FloorEffect =
  | { kind: "releaseSessionsFor"; participantId: string }
  | { kind: "releaseAllSessions" }
  | { kind: "pauseTranslation" }
  | { kind: "resumeTranslation" }
  | { kind: "ensureSession"; source: string };

export interface FloorResult {
  state: FloorState;
  broadcasts: FloorBroadcast[];
  effects: FloorEffect[];
}

export function initialFloorState(autoGrant = false): FloorState {
  return {
    holder: { kind: "none" },
    raised: [],
    autoGrant,
    teacherConnected: false,
  };
}

function floorChanged(floor: FloorHolder, reason: string): FloorBroadcast {
  return { type: "floor-changed", floor, reason };
}

function hands(raised: string[]): FloorBroadcast {
  return { type: "hands", raised: [...raised] };
}

function without(pid: string, raised: string[]): string[] {
  return raised.filter((id) => id !== pid);
}

export function applyFloorEvent(
  state: FloorState,
  event: FloorEvent,
): FloorResult {
  const raised: string[] = [...state.raised];
  switch (event.type) {
    case "teacherStart": {
      // Rows 1 + 5. Teacher always preempts; preempted student must re-raise.
      switch (state.holder.kind) {
        case "teacher":
          return { state, broadcasts: [], effects: [] };
        case "student": {
          const p = state.holder.participantId;
          const next: FloorState = {
            ...state,
            holder: { kind: "teacher" },
            raised,
            teacherConnected: true,
          };
          return {
            state: next,
            broadcasts: [
              floorChanged({ kind: "teacher" }, `preempted:${p}`),
            ],
            effects: [
              { kind: "releaseSessionsFor", participantId: p },
              { kind: "ensureSession", source: "teacher" },
            ],
          };
        }
        case "none": {
          const next: FloorState = {
            ...state,
            holder: { kind: "teacher" },
            raised,
            teacherConnected: true,
          };
          return {
            state: next,
            broadcasts: [floorChanged({ kind: "teacher" }, "teacher-start")],
            effects: [{ kind: "ensureSession", source: "teacher" }],
          };
        }
        default: {
          const _exhaustive: never = state.holder;
          return _exhaustive;
        }
      }
    }

    case "teacherStop": {
      // Row 3. Only meaningful while the teacher holds the floor.
      if (state.holder.kind !== "teacher") {
        return { state, broadcasts: [], effects: [] };
      }
      const next: FloorState = {
        ...state,
        holder: { kind: "none" },
        raised,
      };
      return {
        state: next,
        broadcasts: [floorChanged({ kind: "none" }, "teacher-stop")],
        effects: [{ kind: "releaseSessionsFor", participantId: "teacher" }],
      };
    }

    case "grant": {
      // Rows 2 + 9. Dequeues pid; handover implicitly revokes prior holder.
      const pid = event.participantId;
      if (
        state.holder.kind === "student" &&
        state.holder.participantId === pid
      ) {
        return { state, broadcasts: [], effects: [] };
      }
      if (!raised.includes(pid)) {
        return {
          state,
          broadcasts: [
            { type: "error", code: "grant-absent", participantId: pid },
          ],
          effects: [],
        };
      }
      const queue = without(pid, raised);
      const effects: FloorEffect[] = [];
      if (state.holder.kind === "student") {
        effects.push({
          kind: "releaseSessionsFor",
          participantId: state.holder.participantId,
        });
      } else if (state.holder.kind === "teacher") {
        effects.push({
          kind: "releaseSessionsFor",
          participantId: "teacher",
        });
      }
      effects.push({ kind: "ensureSession", source: pid });
      const reason = state.holder.kind === "none" ? "grant" : "handover";
      const next: FloorState = {
        ...state,
        holder: { kind: "student", participantId: pid },
        raised: queue,
      };
      return {
        state: next,
        broadcasts: [
          floorChanged({ kind: "student", participantId: pid }, reason),
        ],
        effects,
      };
    }

    case "deny": {
      if (!raised.includes(event.participantId)) {
        return { state, broadcasts: [], effects: [] };
      }
      const queue = without(event.participantId, raised);
      return {
        state: { ...state, raised: queue },
        broadcasts: [hands(queue)],
        effects: [],
      };
    }

    case "revoke": {
      // Row 4 (student holder). IDLE/teacher floor: no-op + broadcast sync.
      if (state.holder.kind === "student") {
        const p = state.holder.participantId;
        const next: FloorState = {
          ...state,
          holder: { kind: "none" },
          raised,
        };
        return {
          state: next,
          broadcasts: [floorChanged({ kind: "none" }, "revoke")],
          effects: [{ kind: "releaseSessionsFor", participantId: p }],
        };
      }
      const floor: FloorHolder =
        state.holder.kind === "teacher" ? { kind: "teacher" } : { kind: "none" };
      return {
        state,
        broadcasts: [floorChanged(floor, "revoke-noop")],
        effects: [],
      };
    }

    case "raiseHand": {
      // Rows 7 + 8. Duplicates ignored; speaker raising own hand is a no-op.
      const pid = event.participantId;
      if (
        (state.holder.kind === "student" &&
          state.holder.participantId === pid) ||
        raised.includes(pid)
      ) {
        return { state, broadcasts: [], effects: [] };
      }
      // Row 7 fast path: autoGrant + IDLE grants immediately (rule 2).
      if (state.holder.kind === "none" && state.autoGrant) {
        const next: FloorState = {
          ...state,
          holder: { kind: "student", participantId: pid },
          raised,
        };
        return {
          state: next,
          broadcasts: [
            floorChanged({ kind: "student", participantId: pid }, "grant"),
          ],
          effects: [{ kind: "ensureSession", source: pid }],
        };
      }
      const queue = [...raised, pid];
      return {
        state: { ...state, raised: queue },
        broadcasts: [hands(queue)],
        effects: [],
      };
    }

    case "lowerHand": {
      if (!raised.includes(event.participantId)) {
        return { state, broadcasts: [], effects: [] };
      }
      const queue = without(event.participantId, raised);
      return {
        state: { ...state, raised: queue },
        broadcasts: [hands(queue)],
        effects: [],
      };
    }

    case "speakingStop": {
      // Row 4 (student stop). Stops from anyone else are ignored.
      if (
        state.holder.kind === "student" &&
        state.holder.participantId === event.participantId
      ) {
        const next: FloorState = {
          ...state,
          holder: { kind: "none" },
          raised,
        };
        return {
          state: next,
          broadcasts: [floorChanged({ kind: "none" }, "speaker-stop")],
          effects: [
            { kind: "releaseSessionsFor", participantId: event.participantId },
          ],
        };
      }
      return { state, broadcasts: [], effects: [] };
    }

    case "audioFrame": {
      // Row 6. Frames from the floor holder pass silently (fan-out is T-009);
      // anything else is a violation: no state change + targeted error.
      const holds =
        (event.isTeacher && state.holder.kind === "teacher") ||
        (state.holder.kind === "student" &&
          state.holder.participantId === event.participantId);
      if (holds) {
        return { state, broadcasts: [], effects: [] };
      }
      return {
        state,
        broadcasts: [
          { type: "error", code: "not-your-floor", to: event.participantId },
        ],
        effects: [],
      };
    }

    case "participantDisconnect": {
      // Rows 3 (teacher) + 4/11 (student) + 10 (ANY teacher disconnect).
      if (event.isTeacher) {
        const next: FloorState = {
          ...state,
          holder: { kind: "none" },
          raised,
          teacherConnected: false,
        };
        return {
          state: next,
          broadcasts: [floorChanged({ kind: "none" }, "teacher-gone")],
          effects: [
            { kind: "releaseAllSessions" },
            { kind: "pauseTranslation" },
          ],
        };
      }
      const pid = event.participantId;
      const queue = without(pid, raised);
      if (
        state.holder.kind === "student" &&
        state.holder.participantId === pid
      ) {
        const next: FloorState = {
          ...state,
          holder: { kind: "none" },
          raised: queue,
        };
        return {
          state: next,
          broadcasts: [floorChanged({ kind: "none" }, "disconnect")],
          effects: [{ kind: "releaseSessionsFor", participantId: pid }],
        };
      }
      if (queue.length === raised.length) {
        return { state, broadcasts: [], effects: [] };
      }
      return {
        state: { ...state, raised: queue },
        broadcasts: [hands(queue)],
        effects: [],
      };
    }

    case "teacherJoin": {
      // Row 12. First join flips teacherConnected silently; a second
      // concurrent teacher is rejected (FR-004).
      if (state.teacherConnected) {
        return {
          state,
          broadcasts: [{ type: "error", code: "teacher-taken" }],
          effects: [],
        };
      }
      return {
        state: { ...state, raised, teacherConnected: true },
        broadcasts: [],
        effects: [],
      };
    }

    case "teacherRejoin": {
      // Normative edge case: state resumes at IDLE after teacher rejoin.
      const effects: FloorEffect[] = [{ kind: "resumeTranslation" }];
      if (
        state.holder.kind === "student" ||
        state.holder.kind === "teacher"
      ) {
        const prev =
          state.holder.kind === "student"
            ? state.holder.participantId
            : "teacher";
        effects.unshift({ kind: "releaseSessionsFor", participantId: prev });
      }
      const next: FloorState = {
        ...state,
        holder: { kind: "none" },
        raised,
        teacherConnected: true,
      };
      return {
        state: next,
        broadcasts: [floorChanged({ kind: "none" }, "teacher-rejoin")],
        effects,
      };
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
