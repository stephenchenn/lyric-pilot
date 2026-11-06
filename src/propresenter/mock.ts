import { readFileSync } from "node:fs";
import type { PresenterSnapshot, ProPresenterAdapter, Slide, SlideRef } from "./adapter.ts";
import type { EventLogger } from "../logging/logger.ts";

interface SyntheticSong {
  id: string;
  title: string;
  presentationId: string;
  slides: Omit<Slide, "presentationId">[];
}

export class MockProPresenterAdapter implements ProPresenterAdapter {
  readonly kind = "mock";
  readonly song: SyntheticSong;
  readonly #logger: EventLogger;
  #currentIndex = 0;
  #connected = true;

  constructor(logger: EventLogger) {
    this.#logger = logger;
    this.song = JSON.parse(readFileSync(
      new URL("../../data/songs/synthetic-test/song.json", import.meta.url), "utf8",
    )) as SyntheticSong;
  }

  async connect(): Promise<PresenterSnapshot> {
    return this.getSnapshot();
  }

  async getSnapshot(): Promise<PresenterSnapshot> {
    const slide = this.song.slides[this.#currentIndex]!;
    return {
      health: {
        status: this.#connected ? "connected" : "disconnected",
        checkedAt: new Date().toISOString(),
        message: this.#connected ? "Synthetic mock; no ProPresenter connection" : "Simulated connection loss",
      },
      presentation: this.#connected ? { id: this.song.presentationId, title: this.song.title } : null,
      currentSlide: this.#connected ? {
        id: slide.id, index: slide.index, presentationId: this.song.presentationId,
      } : null,
    };
  }

  async getSlides(presentationId: string): Promise<Slide[]> {
    if (!this.#connected) throw new Error("Mock ProPresenter is disconnected");
    if (presentationId !== this.song.presentationId) throw new Error("Unknown presentation");
    return this.song.slides.map(slide => ({ ...slide, presentationId }));
  }

  async triggerSlide(slide: SlideRef): Promise<void> {
    const slides = await this.getSlides(slide.presentationId);
    const index = slides.findIndex(item => item.id === slide.id && item.index === slide.index);
    if (index < 0) throw new Error("Unknown slide");
    this.#currentIndex = index;
    this.#logger.log("mock_trigger", { slide });
  }

  /** Simulates a selection made in the ProPresenter UI, outside our session. */
  manualSelect(slideId: string): void {
    const index = this.song.slides.findIndex(slide => slide.id === slideId);
    if (index < 0) throw new Error(`Unknown mock slide: ${slideId}`);
    this.#currentIndex = index;
    this.#logger.log("mock_manual_selection", { slideId });
  }

  setConnected(connected: boolean): void {
    this.#connected = connected;
  }

  close(): void {}
}
