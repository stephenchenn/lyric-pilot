import { readFileSync } from "node:fs";
import { words } from "../lyrics/normalize.ts";

export interface LyricSlide {
  id: string;
  index: number;
  sectionId: string;
  sectionSlideIndex: number;
  text: string;
  words: string[];
}
export interface SongSection { id: string; label: string; slideIds: string[] }
export interface ArrangementStep { id: string; sectionId: string; occurrence: number }
export interface Song {
  id: string;
  title: string;
  presentationId: string;
  slides: LyricSlide[];
  sections: SongSection[];
  arrangement: ArrangementStep[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
const alias = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function parseArrangement(input: string | string[], sections: SongSection[]): ArrangementStep[] {
  const labels = typeof input === "string" ? input.split(/\s*(?:->|→|,|\||\n)\s*/) : input;
  if (!labels.length || labels.some(label => !label.trim())) throw new Error("Arrangement must contain section names separated by ->");
  const occurrences = new Map<string, number>();
  return labels.map((label, index) => {
    const exact = sections.filter(section => alias(section.id) === alias(label));
    const matches = exact.length ? exact : sections.filter(section => alias(section.label) === alias(label));
    if (matches.length !== 1) throw new Error(`Unknown or ambiguous arrangement section: ${label}`);
    const section = matches[0]!;
    const occurrence = (occurrences.get(section.id) ?? 0) + 1;
    occurrences.set(section.id, occurrence);
    return { id: `step-${index + 1}`, sectionId: section.id, occurrence };
  });
}

export function parseSong(value: unknown, arrangement?: string): Song {
  const input = object(value, "song");
  if (!Array.isArray(input.sections) || !input.sections.length || !Array.isArray(input.slides) || !input.slides.length) {
    throw new Error("Song must contain nonempty sections and slides arrays");
  }
  const sections = input.sections.map((value, index) => {
    const section = object(value, `section ${index}`);
    if (!Array.isArray(section.slideIds) || !section.slideIds.length) throw new Error("Every section must have slideIds");
    return {
      id: string(section.id, "section.id"), label: string(section.label, "section.label"),
      slideIds: section.slideIds.map(id => string(id, "section.slideId")),
    };
  });
  if (new Set(sections.map(section => section.id)).size !== sections.length) throw new Error("Duplicate section id");
  const owned = sections.flatMap(section => section.slideIds);
  if (new Set(owned).size !== owned.length) throw new Error("Each physical slide must belong to exactly one section");
  const slides = input.slides.map((value, index) => {
    const slide = object(value, `slide ${index}`);
    const id = string(slide.id, "slide.id");
    const section = sections.find(section => section.slideIds.includes(id));
    if (!section) throw new Error(`Slide ${id} is not in a section`);
    if (slide.section !== undefined && slide.section !== section.id) throw new Error(`Slide ${id} has inconsistent section metadata`);
    if (typeof slide.index !== "number" || !Number.isSafeInteger(slide.index) || slide.index < 0) throw new Error("Slide index must be a nonnegative integer");
    if (typeof slide.text !== "string") throw new Error("Slide text must be a string");
    return { id, index: slide.index, sectionId: section.id, sectionSlideIndex: section.slideIds.indexOf(id), text: slide.text, words: words(slide.text) };
  }).sort((a, b) => a.index - b.index);
  if (new Set(slides.map(slide => slide.id)).size !== slides.length || new Set(slides.map(slide => slide.index)).size !== slides.length) {
    throw new Error("Slide IDs and indices must be unique");
  }
  if (owned.length !== slides.length || owned.some(id => !slides.some(slide => slide.id === id))) throw new Error("Section references an unknown slide");
  const plan = arrangement ?? input.arrangement;
  if (typeof plan !== "string" && (!Array.isArray(plan) || !plan.every(value => typeof value === "string"))) {
    throw new Error("Song arrangement must be a string or string array");
  }
  return {
    id: string(input.id, "song.id"), title: string(input.title, "song.title"),
    presentationId: string(input.presentationId, "song.presentationId"), slides, sections,
    arrangement: parseArrangement(plan as string | string[], sections),
  };
}

export const defaultSongPath = new URL("../../data/songs/synthetic-test/song.json", import.meta.url).pathname;
export function loadSong(path = defaultSongPath, arrangement?: string): Song {
  return parseSong(JSON.parse(readFileSync(path, "utf8")), arrangement);
}
