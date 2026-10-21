// T-013: dependency-free hash router (`#/create`, `#/join`, `#/room?...`).
// Hash routing keeps the SPA deployable as static assets with no server rewrite
// rules (SPEC NFR-006).

import { useSyncExternalStore } from "react";

import type { ParticipantLang, SupportedUiLang } from "./i18n.js";
import { isParticipantLang, isSupportedUiLang } from "./i18n.js";

export type Role = "teacher" | "student";

export type Route =
  | { readonly name: "home" }
  | { readonly name: "create" }
  | {
      readonly name: "join";
      readonly prefillCode: string | null;
      readonly prefillRole: Role;
      readonly prefillLang: ParticipantLang | null;
    }
  | { readonly name: "not-found"; readonly path: string }
  | { readonly name: "room"; readonly params: RoomRouteParams };

export interface RoomRouteParams {
  readonly code: string;
  readonly token: string;
  readonly role: Role;
  readonly lang: ParticipantLang;
  readonly ui: SupportedUiLang;
  /**
   * Display name, carried in the route because the join token holds no name
   * (docs/PROTOCOL.md section 1, section 4). `Room` forwards it as `&name=` on
   * the WebSocket request; the DO falls back to the participant id without it.
   */
  readonly name: string;
}

export function roomHash(params: RoomRouteParams): string {
  const query = new URLSearchParams({
    code: params.code,
    token: params.token,
    role: params.role,
    lang: params.lang,
    ui: params.ui,
    name: params.name,
  });
  return `#/room?${query.toString()}`;
}

export interface JoinPrefill {
  readonly code: string;
  readonly role: Role;
  readonly lang: ParticipantLang;
}

export function joinHash(prefill: JoinPrefill): string {
  const query = new URLSearchParams({
    code: prefill.code,
    role: prefill.role,
    lang: prefill.lang,
  });
  return `#/join?${query.toString()}`;
}

function firstOf(raw: string | null): string {
  return raw === null || raw === "" ? "" : (raw.split(",")[0] ?? "");
}

export function parseHash(hash: string): Route {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryStart = withoutHash.indexOf("?");
  const path = (queryStart === -1 ? withoutHash : withoutHash.slice(0, queryStart))
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const query =
    queryStart === -1
      ? new URLSearchParams()
      : new URLSearchParams(withoutHash.slice(queryStart + 1));

  switch (path) {
    case "":
      return { name: "home" };
    case "create":
      return { name: "create" };
    case "join": {
      const code = firstOf(query.get("code"));
      const lang = firstOf(query.get("lang"));
      return {
        name: "join",
        prefillCode: code === "" ? null : code,
        prefillRole: readRole(firstOf(query.get("role"))),
        prefillLang: isParticipantLang(lang) ? lang : null,
      };
    }
    case "room": {
      const parsed = readRoomParams(query);
      return parsed === null
        ? { name: "not-found", path: `/${path}` }
        : { name: "room", params: parsed };
    }
    default:
      return { name: "not-found", path: `/${path}` };
  }
}

function readRole(raw: string): Role {
  return raw === "teacher" ? "teacher" : "student";
}

function readRoomParams(query: URLSearchParams): RoomRouteParams | null {
  const code = firstOf(query.get("code"));
  const token = firstOf(query.get("token"));
  const lang = firstOf(query.get("lang"));
  const role = firstOf(query.get("role"));
  const ui = firstOf(query.get("ui"));
  if (code === "" || token === "") return null;
  if (!isParticipantLang(lang)) return null;
  return {
    code,
    token,
    lang,
    name: firstOf(query.get("name")),
    role: readRole(role),
    ui: isSupportedUiLang(ui) ? ui : "ar",
  };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

// T-016 gap-fill: useSyncExternalStore requires a CACHED snapshot — returning
// a fresh parseHash object on every read retriggers a render forever (React
// "getSnapshot should be cached" infinite loop, crash #185 on every page).
// The cache key is the raw hash: same hash, same object identity, no rescan.
let lastHashSnapshot = "";
let lastRouteSnapshot: Route | null = null;

function getRouteSnapshot(): Route {
  const hash = window.location.hash;
  if (lastRouteSnapshot === null || hash !== lastHashSnapshot) {
    lastHashSnapshot = hash;
    lastRouteSnapshot = parseHash(hash);
  }
  return lastRouteSnapshot;
}

const HOME_ROUTE: Route = { name: "home" };

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getRouteSnapshot, () => HOME_ROUTE);
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}