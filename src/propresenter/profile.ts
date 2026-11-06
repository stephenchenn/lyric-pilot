import { readFileSync } from "node:fs";

interface ReadEndpoint { path: string }
export interface TriggerEndpoint {
  path: string;
  method: "GET" | "POST" | "PUT";
  body?: unknown;
}

export interface ApiProfile {
  schemaVersion: 1;
  verified: true;
  documentation: { url: string; applicationVersion: string; reviewedAt: string };
  indexBase: 0 | 1;
  endpoints: {
    health: ReadEndpoint;
    activePresentation: ReadEndpoint;
    currentSlide: ReadEndpoint;
    slides: ReadEndpoint;
    triggerSlide: TriggerEndpoint;
  };
  mapping: {
    presentation: { root: string; id: string; title: string };
    currentSlide: { root: string; id: string; index: string; presentationId: string };
    slides: { root: string; id: string; index: string; text: string; section?: string };
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || /REPLACE/i.test(value)) {
    throw new Error(`${label} must be filled in from the installed API documentation`);
  }
  return value;
}

export function assertRelativePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\s#]/.test(path)) {
    throw new Error("API paths must start with a single / and stay on the configured host");
  }
  const url = new URL(path, "http://local.invalid");
  if (url.origin !== "http://local.invalid") throw new Error("Cross-origin API path rejected");
  for (const segment of path.split(/[/?]/)) {
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === "..") throw new Error("Dot segments are not allowed in API paths");
  }
}

function endpoint(value: unknown, label: string, allowedParams: string[]): ReadEndpoint {
  const path = string(record(value, label).path, `${label}.path`);
  assertRelativePath(path);
  for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
    if (!allowedParams.includes(match[1]!)) throw new Error(`Unsupported placeholder in ${label}: ${match[0]}`);
  }
  if (/[{}]/.test(path.replace(/\{[^{}]+\}/g, ""))) throw new Error(`Invalid placeholders in ${label}`);
  return { path };
}

function pointers(value: unknown, label: string, keys: string[]): Record<string, string> {
  const input = record(value, label);
  return Object.fromEntries(keys.map(key => {
    const pointer = string(input[key], `${label}.${key}`, true);
    if ((pointer !== "" && !pointer.startsWith("/")) || /~(?![01])/.test(pointer)) {
      throw new Error(`${label}.${key} must be a JSON Pointer, such as /data/id or an empty string`);
    }
    return [key, pointer];
  }));
}

export function parseProfile(value: unknown): ApiProfile {
  const input = record(value, "profile");
  if (input.schemaVersion !== 1) throw new Error("Unsupported profile schemaVersion; expected 1");
  if (input.verified !== true) {
    throw new Error("API profile is unverified. Inspect the installed ProPresenter API docs, fill in the profile, then set verified to true");
  }
  const docs = record(input.documentation, "documentation");
  const url = string(docs.url, "documentation.url");
  if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("documentation.url must be an HTTP(S) URL");
  const applicationVersion = string(docs.applicationVersion, "documentation.applicationVersion");
  const reviewedAt = string(docs.reviewedAt, "documentation.reviewedAt");
  if (Number.isNaN(Date.parse(reviewedAt))) throw new Error("documentation.reviewedAt must be a date");
  if (input.indexBase !== 0 && input.indexBase !== 1) throw new Error("indexBase must be 0 or 1");
  const endpoints = record(input.endpoints, "endpoints");
  const trigger = record(endpoints.triggerSlide, "endpoints.triggerSlide");
  if (trigger.method !== "GET" && trigger.method !== "POST" && trigger.method !== "PUT") {
    throw new Error("triggerSlide.method must be GET, POST or PUT, as specified by the installed docs");
  }
  if (trigger.method === "GET" && trigger.body !== undefined) throw new Error("GET triggers cannot have a request body");
  const mapping = record(input.mapping, "mapping");
  const presentation = pointers(mapping.presentation, "mapping.presentation", ["root", "id", "title"]);
  const currentSlide = pointers(mapping.currentSlide, "mapping.currentSlide", ["root", "id", "index", "presentationId"]);
  const slides = pointers(mapping.slides, "mapping.slides", ["root", "id", "index", "text"]);
  if (record(mapping.slides, "mapping.slides").section !== undefined) {
    Object.assign(slides, pointers(mapping.slides, "mapping.slides", ["section"]));
  }
  // All keys and types are validated above; the assertion retains the named mapping keys.
  return {
    schemaVersion: 1, verified: true,
    documentation: { url, applicationVersion, reviewedAt }, indexBase: input.indexBase,
    endpoints: {
      health: endpoint(endpoints.health, "endpoints.health", []),
      activePresentation: endpoint(endpoints.activePresentation, "endpoints.activePresentation", []),
      currentSlide: endpoint(endpoints.currentSlide, "endpoints.currentSlide", []),
      slides: endpoint(endpoints.slides, "endpoints.slides", ["presentationId"]),
      triggerSlide: {
        ...endpoint(trigger, "endpoints.triggerSlide", ["presentationId", "slideId", "index"]),
        method: trigger.method,
        ...(trigger.body !== undefined ? { body: trigger.body } : {}),
      },
    },
    mapping: { presentation, currentSlide, slides } as ApiProfile["mapping"],
  };
}

export function loadProfile(path: string): ApiProfile {
  return parseProfile(JSON.parse(readFileSync(path, "utf8")));
}

/** RFC 6901 JSON Pointer. Missing fields are errors, never silently guessed. */
export function atPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current = value;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
      throw new Error(`Response does not contain configured JSON Pointer ${pointer}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function expandPath(path: string, params: Record<string, string | number>): string {
  const expanded = path.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(params, key)) throw new Error(`Missing path parameter ${key}`);
    return encodeURIComponent(String(params[key]));
  });
  assertRelativePath(expanded);
  return expanded;
}

/** A whole-value body placeholder preserves index as a number. */
export function expandBody(value: unknown, params: Record<string, string | number>): unknown {
  if (typeof value === "string") {
    const exact = /^\{([^{}]+)\}$/.exec(value);
    if (exact) {
      if (!Object.hasOwn(params, exact[1]!)) throw new Error(`Unknown body placeholder ${value}`);
      return params[exact[1]!]!;
    }
    return value.replace(/\{([^{}]+)\}/g, (_, key: string) => {
      if (!Object.hasOwn(params, key)) throw new Error(`Unknown body placeholder {${key}}`);
      return String(params[key]);
    });
  }
  if (Array.isArray(value)) return value.map(item => expandBody(item, params));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandBody(item, params)]));
  }
  return value;
}
