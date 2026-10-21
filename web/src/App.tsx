// T-013: SPA shell + hash routing. Arabic is the default UI language and RTL is
// the default direction (NFR-004); `dir`/`lang` on <html> follow the switcher so
// the whole tree flips without per-component branches.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useLatencyMs } from "./audio/latency.js";
import {
  DEFAULT_UI_LANG,
  SUPPORTED_UI_LANGS,
  dirFor,
  getStrings,
  isSupportedUiLang,
  type SupportedUiLang,
} from "./i18n.js";
import { MetricsPanel } from "./components/MetricsPanel.js";
import { UiLangContext } from "./uiLang.js";
import { navigate, useRoute, type RoomRouteParams } from "./router.js";
import { Create } from "./screens/Create.js";
import { Join } from "./screens/Join.js";
import { Room } from "./screens/Room.js";

const LANG_STORAGE_KEY = "fitra.uiLang";

function readStoredLang(): SupportedUiLang {
  try {
    const stored = window.localStorage.getItem(LANG_STORAGE_KEY);
    return stored !== null && isSupportedUiLang(stored) ? stored : DEFAULT_UI_LANG;
  } catch {
    return DEFAULT_UI_LANG;
  }
}

export default function App(): React.JSX.Element {
  const [lang, setLang] = useState<SupportedUiLang>(readStoredLang);
  const route = useRoute();

  const setUiLang = useCallback((next: SupportedUiLang) => {
    setLang(next);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // Private-mode storage denial is not fatal: the language still applies.
    }
  }, []);

  const toggleLang = useCallback(() => {
    const index = SUPPORTED_UI_LANGS.indexOf(lang);
    const next = SUPPORTED_UI_LANGS[(index + 1) % SUPPORTED_UI_LANGS.length];
    if (next !== undefined) setUiLang(next);
  }, [lang, setUiLang]);

  const dir = dirFor(lang);
  const contextValue = useMemo(
    () => ({ lang, dir, setLang: setUiLang, toggleLang }),
    [lang, dir, setUiLang, toggleLang],
  );

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  useEffect(() => {
    if (route.name === "room" && route.params.ui !== lang) {
      setUiLang(route.params.ui);
    }
  }, [route, lang, setUiLang]);

  const strings = getStrings(lang);

  return (
    <UiLangContext.Provider value={contextValue}>
      <div dir={dir} lang={lang} className="flex min-h-screen flex-col bg-paper">
        <header className="ui-header">
          <div className="ui-header-inner">
            <a href="#/" className="group flex items-baseline gap-2" data-testid="brand">
              <span className="text-2xl font-bold tracking-tight text-brand-700">
                {strings.appTitle}
              </span>
              <span className="text-xs text-ink-500 transition group-hover:text-brand-600">
                {strings.appTagline}
              </span>
            </a>

            <nav className="order-last flex flex-wrap items-center gap-1 sm:order-none">
              <NavLink href="#/create" label={strings.navCreate} testId="nav-create" />
              <NavLink href="#/join" label={strings.navJoin} testId="nav-join" />
            </nav>

            <button
              type="button"
              className="ui-btn-secondary ui-btn-sm ms-auto"
              onClick={toggleLang}
              data-testid="toggle-ui-lang"
              aria-label={strings.uiLangLabel}
            >
              {strings[langNameKey(lang)]}
            </button>
          </div>
        </header>

        <div className="flex-1">
          <RouteView route={route} strings={strings} />
        </div>

        <footer className="border-t border-paper-line px-5 py-4">
          <p className="mx-auto max-w-5xl text-xs text-ink-500">
            {strings.testDeploymentBadge}
          </p>
        </footer>
      </div>
    </UiLangContext.Provider>
  );
}

function langNameKey(lang: SupportedUiLang): "langNameAr" | "langNameEn" | "langNameFr" | "langNameEs" {
  switch (lang) {
    case "ar":
      return "langNameAr";
    case "en":
      return "langNameEn";
    case "fr":
      return "langNameFr";
    case "es":
      return "langNameEs";
    default:
      return "langNameAr";
  }
}

function NavLink({
  href,
  label,
  testId,
}: {
  readonly href: string;
  readonly label: string;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <a
      href={href}
      data-testid={testId}
      className="rounded-md px-3 py-2 text-sm font-semibold text-ink-600 transition hover:bg-brand-50 hover:text-brand-700"
    >
      {label}
    </a>
  );
}

function RouteView({
  route,
  strings,
}: {
  readonly route: ReturnType<typeof useRoute>;
  readonly strings: ReturnType<typeof getStrings>;
}): React.JSX.Element {
  switch (route.name) {
    case "home":
      return <Home strings={strings} />;
    case "create":
      return <Create />;
    case "join":
      return (
        <Join
          prefillCode={route.prefillCode}
          prefillRole={route.prefillRole}
          prefillLang={route.prefillLang}
        />
      );
    case "room":
      return <RoomWithMetrics session={route.params} />;
    case "not-found":
      return (
        <main className="ui-page-narrow text-center">
          <h1 className="ui-title">404</h1>
          <p className="ui-subtitle mt-3">{route.path}</p>
          <button
            type="button"
            className="ui-btn-primary mt-6"
            onClick={() => navigate("#/")}
          >
            {strings.backHome}
          </button>
        </main>
      );
    default:
      return <Home strings={strings} />;
  }
}

// T-012: the room socket stays inside <Room>; this shell only adds what the
// panel needs on top of the last `RoomMetrics` the DO broadcast — the latency
// estimate measured in this browser.
function RoomWithMetrics({
  session,
}: {
  readonly session: RoomRouteParams;
}): React.JSX.Element {
  const latency = useLatencyMs();
  return (
    <Room
      session={session}
      renderMetrics={(metrics) => (
        <MetricsPanel
          metrics={metrics}
          latencyMs={latency.ms}
          latencySamples={latency.samples}
        />
      )}
    />
  );
}

function Home({
  strings,
}: {
  readonly strings: ReturnType<typeof getStrings>;
}): React.JSX.Element {
  const steps = [
    { title: strings.homeStep1Title, body: strings.homeStep1Body, cta: strings.homeCreateCta, href: "#/create" },
    { title: strings.homeStep2Title, body: strings.homeStep2Body, cta: strings.homeJoinCta, href: "#/join" },
  ];

  return (
    <main className="ui-page">
      <section className="animate-rise-in">
        <p className="ui-chip-brand">{strings.appTagline}</p>
        <h1 className="ui-title mt-4 max-w-2xl">{strings.homeLead}</h1>

        <div className="mt-8 flex flex-wrap gap-3">
          <a href="#/create" className="ui-btn-primary" data-testid="home-create">
            {strings.homeCreateCta}
          </a>
          <a href="#/join" className="ui-btn-secondary" data-testid="home-join">
            {strings.homeJoinCta}
          </a>
        </div>
      </section>

      <section className="stagger mt-12 grid gap-6 md:grid-cols-2">
        {steps.map((step) => (
          <article key={step.href} className="ui-card flex flex-col p-5">
            <h2 className="text-lg font-bold text-ink-900">{step.title}</h2>
            <p className="ui-subtitle mt-2 flex-1 text-base">{step.body}</p>
            <a href={step.href} className="ui-btn-secondary ui-btn-sm mt-5 self-start">
              {step.cta}
            </a>
          </article>
        ))}
      </section>

      <section className="ui-card mt-6 p-5">
        <h2 className="ui-section-title">{strings.homeFloorTitle}</h2>
        <p className="ui-subtitle mt-2 text-base">{strings.homeFloorBody}</p>
      </section>
    </main>
  );
}