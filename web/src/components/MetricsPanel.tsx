// T-012: live metrics panel. Rendered by the room shell through
// `RoomProps.renderMetrics` into `#metrics-mount` (docs/TEST-PLAN.md §3.1), so it
// brings no outer card of its own — the mount already provides `.ui-card p-4`.
//
// Split of truth: the DO is authoritative for rates, sessions, reconnects,
// errors and active seconds (`RoomMetrics`, docs/PROTOCOL.md §3). The end-to-end
// latency is measured in the browser (`audio/latency.ts`, first translated chunk
// back) and is shown as soon as it exists, falling back to the server figure
// until then. Display only: nothing here writes anywhere.
//
// Strings come from the language context rather than from props, because the
// room shell injects this panel through a `metrics`-only seam; the sub-pieces
// below still take `strings` explicitly, exactly as Room.tsx passes them down.

import type { RoomMetrics } from "@fitra/shared";

import { fmt, getStrings, type UiStrings } from "../i18n.js";
import { useUiLang } from "../uiLang.js";

/** Shown for a metric the room has not measured yet (never a fake zero). */
const PENDING = "—";

export interface MetricsPanelProps {
  /** Last `metrics` broadcast by the DO; `null` until the first one arrives. */
  readonly metrics: RoomMetrics | null;
  /** Local end-to-end estimate in ms; `null` before the first round trip. */
  readonly latencyMs: number | null;
  /** Samples behind {@link latencyMs}, so one lucky spike is not a headline. */
  readonly latencySamples?: number;
}

type LatencySource = "local" | "server" | "none";

interface StatusChip {
  readonly className: string;
  readonly label: string;
}

/** `RoomMetricsSession.status` is a free-form string; known values map to i18n. */
const SESSION_STATUS_LABELS: Readonly<Record<string, keyof UiStrings>> = {
  connecting: "statusConnecting",
  live: "statusLive",
  reconnecting: "statusReconnecting",
  failed: "statusFailed",
  degraded: "statusDegraded",
};

const SESSION_STATUS_CHIPS: Readonly<Record<string, string>> = {
  connecting: "ui-chip-neutral",
  live: "ui-chip-live",
  reconnecting: "ui-chip-live",
  failed: "ui-chip-neutral",
  degraded: "ui-chip-neutral",
};

export function MetricsPanel({
  metrics,
  latencyMs,
  latencySamples = 0,
}: MetricsPanelProps): React.JSX.Element {
  const { lang } = useUiLang();
  const strings = getStrings(lang);

  // The browser knows first, the DO second; `data-source` keeps the two apart
  // so an E2E assert can tell a measured local round trip from a server report.
  const local: LatencySource = latencyMs === null ? "none" : "local";
  const latency = latencyMs ?? metrics?.e2eLatencyMs ?? null;
  const source: LatencySource = local === "none" && latency !== null ? "server" : local;

  return (
    <div data-testid="metrics-panel">
      <header className="flex items-center justify-between gap-3">
        <h2 className="ui-section-title">{strings.metricsTitle}</h2>
        {metrics === null ? (
          <span className="ui-chip-neutral" data-testid="metrics-pending">
            {PENDING}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="ui-dot-live animate-pulse-live"
            data-testid="metrics-live"
          />
        )}
      </header>

      <LatencyFigure
        strings={strings}
        latencyMs={latency}
        samples={latencySamples}
        source={source}
      />

      <dl className="mt-4 grid grid-cols-2 gap-2">
        <MetricTile
          label={strings.metricsInbound}
          value={formatRate(metrics?.inboundMsgPerSec)}
          testId="metric-inbound"
        />
        <MetricTile
          label={strings.metricsOutbound}
          value={formatRate(metrics?.outboundMsgPerSec)}
          testId="metric-outbound"
        />
        <MetricTile
          label={strings.metricsErrors}
          value={formatCount(metrics?.errorsLastMin)}
          testId="metric-errors"
        />
        <MetricTile
          label={strings.metricsDoActive}
          value={formatCount(metrics?.doActiveSec)}
          testId="metric-do-active"
        />
      </dl>

      <SessionsTable strings={strings} metrics={metrics} />
    </div>
  );
}

function LatencyFigure({
  strings,
  latencyMs,
  samples,
  source,
}: {
  readonly strings: UiStrings;
  readonly latencyMs: number | null;
  readonly samples: number;
  readonly source: LatencySource;
}): React.JSX.Element {
  return (
    <div
      className="ui-card-quiet mt-3 p-3"
      data-testid="metric-latency"
      data-latency-ms={latencyMs === null ? undefined : Math.round(latencyMs)}
      data-samples={samples}
      data-source={source}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="ui-hint">{strings.metricsLatency}</p>
        <p
          className="text-3xl font-bold leading-none tracking-tight text-brand-700 tabular-nums"
          data-testid="metric-latency-value"
          role="status"
          aria-live="polite"
        >
          {latencyMs === null ? PENDING : formatMs(latencyMs)}
          {latencyMs !== null && (
            <span className="ms-1 text-xs font-semibold text-ink-500">ms</span>
          )}
        </p>
      </div>
      <p className="ui-hint mt-1.5">{latencyCaption(strings, latencyMs, samples, source)}</p>
    </div>
  );
}

function latencyCaption(
  strings: UiStrings,
  latencyMs: number | null,
  samples: number,
  source: LatencySource,
): string {
  if (latencyMs === null) {
    return strings.metricsLatencyEmpty;
  }
  if (source === "server") {
    return strings.metricsLatencyServer;
  }
  return samples > 0
    ? fmt(strings.metricsLatencySamples, { count: samples })
    : strings.metricsLatencySource;
}

function MetricTile({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <div className="ui-card-quiet p-3" data-testid={testId}>
      <dt className="ui-hint">{label}</dt>
      <dd className="mt-1 text-lg font-bold text-ink-900 tabular-nums">{value}</dd>
    </div>
  );
}

function SessionsTable({
  strings,
  metrics,
}: {
  readonly strings: UiStrings;
  readonly metrics: RoomMetrics | null;
}): React.JSX.Element {
  const sessions = metrics?.sessions ?? [];
  return (
    <section className="mt-4" aria-label={strings.metricsSessionsTitle}>
      <h3 className="ui-section-title">{strings.metricsSessionsTitle}</h3>
      {sessions.length === 0 ? (
        <p className="ui-hint mt-2" data-testid="metric-sessions-empty">
          {metrics === null ? strings.metricsWaiting : strings.metricsSessionsEmpty}
        </p>
      ) : (
        <table className="mt-2 w-full text-start text-sm" data-testid="metric-sessions">
          <thead>
            <tr className="text-ink-500">
              <th scope="col" className="pb-1 text-start font-semibold">
                {strings.metricsPair}
              </th>
              <th scope="col" className="pb-1 text-start font-semibold">
                {strings.metricsStatus}
              </th>
              <th scope="col" className="pb-1 text-end font-semibold">
                {strings.metricsReconnects}
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const chip = statusChip(strings, session.status);
              return (
                <tr
                  key={session.pair}
                  className="border-t border-paper-line"
                  data-testid={`metric-session-${session.pair}`}
                  data-status={session.status}
                >
                  <td className="py-1.5 pe-3 font-mono text-xs text-ink-700">
                    {session.pair}
                  </td>
                  <td className="py-1.5 pe-3">
                    <span className={chip.className}>{chip.label}</span>
                  </td>
                  <td className="py-1.5 text-end tabular-nums text-ink-700">
                    {session.reconnects}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function statusChip(strings: UiStrings, status: string): StatusChip {
  const labelKey = Object.hasOwn(SESSION_STATUS_LABELS, status)
    ? SESSION_STATUS_LABELS[status]
    : undefined;
  const chipClass = Object.hasOwn(SESSION_STATUS_CHIPS, status)
    ? SESSION_STATUS_CHIPS[status]
    : undefined;
  return {
    // An unknown status shows verbatim instead of being folded into "live":
    // this panel is a diagnostic surface, not a health badge.
    className: chipClass ?? "ui-chip-neutral",
    label: labelKey === undefined ? status : strings[labelKey],
  };
}

export function formatMs(value: number): string {
  return String(Math.round(value));
}

export function formatRate(value: number | undefined): string {
  return value === undefined ? PENDING : value.toFixed(1);
}

export function formatCount(value: number | undefined): string {
  return value === undefined ? PENDING : String(Math.round(value));
}
