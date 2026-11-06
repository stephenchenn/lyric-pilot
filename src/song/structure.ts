import type { LyricSlide, Song } from "./model.ts";

export interface LyricPosition {
  slideId: string;
  sectionId: string;
  sectionSlideIndex: number;
  stepIndex: number | null;
  occurrence: number | null;
  extraRepeat: number;
}
export const samePosition = (a: LyricPosition, b: LyricPosition) =>
  a.slideId === b.slideId && a.stepIndex === b.stepIndex && a.extraRepeat === b.extraRepeat;

export class StructureTracker {
  readonly song: Song;
  #position: LyricPosition;
  #history: string[] = [];
  #deviation = false;

  constructor(song: Song, initialSlideId?: string, stepIndex?: number) {
    this.song = song;
    const first = initialSlideId ?? song.sections.find(section => section.id === song.arrangement[0]!.sectionId)!.slideIds[0]!;
    this.#position = this.#initial(first, stepIndex);
  }

  #initial(slideId: string, stepIndex?: number): LyricPosition {
    const slide = this.song.slides.find(slide => slide.id === slideId);
    if (!slide) throw new Error(`Unknown slide: ${slideId}`);
    const step = stepIndex ?? this.song.arrangement.findIndex(step => step.sectionId === slide.sectionId);
    if (stepIndex !== undefined && (!Number.isInteger(stepIndex) || stepIndex < 0 || this.song.arrangement[stepIndex]?.sectionId !== slide.sectionId)) {
      throw new Error("Arrangement step does not contain the selected slide (step indices are zero based)");
    }
    return this.#forSlide(slide, step < 0 ? null : step);
  }

  #forSlide(slide: LyricSlide, stepIndex: number | null, extraRepeat = 0): LyricPosition {
    return {
      slideId: slide.id, sectionId: slide.sectionId, sectionSlideIndex: slide.sectionSlideIndex,
      stepIndex, occurrence: stepIndex === null ? null : this.song.arrangement[stepIndex]!.occurrence,
      extraRepeat,
    };
  }

  get current(): LyricPosition { return { ...this.#position }; }
  get history(): string[] { return [...this.#history]; }
  get deviation(): boolean { return this.#deviation; }

  get expected(): LyricPosition | null {
    const section = this.song.sections.find(section => section.id === this.#position.sectionId)!;
    const nextId = section.slideIds[this.#position.sectionSlideIndex + 1];
    if (nextId) return this.#forSlide(this.song.slides.find(slide => slide.id === nextId)!, this.#position.stepIndex, this.#position.extraRepeat);
    if (this.#position.stepIndex === null) return null;
    const nextStepIndex = this.#position.stepIndex + 1;
    const step = this.song.arrangement[nextStepIndex];
    if (!step) return null;
    const firstId = this.song.sections.find(section => section.id === step.sectionId)!.slideIds[0]!;
    return this.#forSlide(this.song.slides.find(slide => slide.id === firstId)!, nextStepIndex);
  }

  resolve(slide: LyricSlide): LyricPosition {
    // Identical audio cannot establish a new occurrence of a one-slide section.
    // Holding its physical slide must not create phantom repeats or re-triggers.
    if (slide.id === this.#position.slideId) return this.current;
    const expected = this.expected;
    if (expected?.slideId === slide.id) return expected;
    if (slide.sectionId === this.#position.sectionId) {
      if (slide.id === this.#position.slideId || slide.sectionSlideIndex > this.#position.sectionSlideIndex) {
        return this.#forSlide(slide, this.#position.stepIndex, this.#position.extraRepeat);
      }
      // An unplanned repeat keeps the plan cursor here, so its end still leads to
      // the previously planned next section rather than skipping ahead to a final chorus.
      return this.#forSlide(slide, this.#position.stepIndex, this.#position.extraRepeat + 1);
    }
    const after = this.#position.stepIndex ?? -1;
    let index = this.song.arrangement.findIndex((step, index) => index > after && step.sectionId === slide.sectionId);
    if (index < 0) index = this.song.arrangement.findLastIndex(step => step.sectionId === slide.sectionId);
    return this.#forSlide(slide, index < 0 ? null : index);
  }

  accept(position: LyricPosition): { changed: boolean; deviation: boolean } {
    if (samePosition(position, this.#position)) return { changed: false, deviation: this.#deviation };
    const expected = this.expected;
    const deviation = !expected || !samePosition(position, expected) || position.extraRepeat > 0;
    this.#history = [...this.#history, this.#position.slideId].slice(-8);
    this.#position = { ...position };
    this.#deviation = deviation;
    return { changed: true, deviation };
  }

  reanchor(slideId: string, stepIndex?: number): void {
    const slide = this.song.slides.find(slide => slide.id === slideId);
    if (!slide) throw new Error(`Unknown slide: ${slideId}`);
    const next = stepIndex === undefined ? this.resolve(slide) : this.#initial(slideId, stepIndex);
    this.#history = [];
    this.#position = next;
    this.#deviation = false;
  }
}
