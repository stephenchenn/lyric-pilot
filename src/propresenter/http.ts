import { errorMessage, type PresenterSnapshot, type ProPresenterAdapter, type Slide, type SlideRef } from "./adapter.ts";
import { HttpClient } from "./client.ts";
import { atPointer, expandBody, expandPath, type ApiProfile } from "./profile.ts";

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string; check the profile mapping`);
  return value;
}

function index(value: unknown, base: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < base) {
    throw new Error("Slide index must be an integer at or above indexBase; check the profile mapping");
  }
  return value - base;
}

export class HttpProPresenterAdapter implements ProPresenterAdapter {
  readonly kind = "http";
  readonly #client: HttpClient;
  readonly #profile: ApiProfile;

  constructor(client: HttpClient, profile: ApiProfile) {
    this.#client = client;
    this.#profile = profile;
  }

  async connect(): Promise<PresenterSnapshot> { return this.getSnapshot(); }

  async getSnapshot(): Promise<PresenterSnapshot> {
    let reachable = false;
    try {
      const { endpoints, mapping, indexBase } = this.#profile;
      await this.#client.request("GET", endpoints.health.path);
      reachable = true;
      const presentationData = (await this.#client.request("GET", endpoints.activePresentation.path)).body;
      const slideData = (await this.#client.request("GET", endpoints.currentSlide.path)).body;
      const presentation = atPointer(presentationData, mapping.presentation.root);
      const currentSlide = atPointer(slideData, mapping.currentSlide.root);
      const result: PresenterSnapshot = {
        health: { status: "connected", checkedAt: new Date().toISOString(), message: "Installed-version API profile responded" },
        presentation: presentation === null ? null : {
          id: text(atPointer(presentation, mapping.presentation.id), "Presentation id"),
          title: text(atPointer(presentation, mapping.presentation.title), "Presentation title"),
        },
        currentSlide: currentSlide === null ? null : {
          id: text(atPointer(currentSlide, mapping.currentSlide.id), "Slide id"),
          presentationId: text(atPointer(currentSlide, mapping.currentSlide.presentationId), "Slide presentationId"),
          index: index(atPointer(currentSlide, mapping.currentSlide.index), indexBase),
        },
      };
      if (result.currentSlide && result.currentSlide.presentationId !== result.presentation?.id) {
        throw new Error("Presentation and current slide disagree; holding controls until the next consistent poll");
      }
      return result;
    } catch (error) {
      return {
        health: {
          status: reachable ? "degraded" : "disconnected", checkedAt: new Date().toISOString(), message: errorMessage(error),
        },
        presentation: null, currentSlide: null,
      };
    }
  }

  async getSlides(presentationId: string): Promise<Slide[]> {
    const { endpoints, mapping, indexBase } = this.#profile;
    const response = await this.#client.request("GET", expandPath(endpoints.slides.path, { presentationId }));
    const items = atPointer(response.body, mapping.slides.root);
    if (!Array.isArray(items)) throw new Error("Configured slides root must point to an array");
    const slides = items.map(item => {
      const lyricText = atPointer(item, mapping.slides.text);
      if (typeof lyricText !== "string") throw new Error("Slide text must be a string; check the profile mapping");
      const section = mapping.slides.section === undefined ? null : atPointer(item, mapping.slides.section);
      if (section !== null && typeof section !== "string") throw new Error("Slide section must be a string or null");
      return {
        id: text(atPointer(item, mapping.slides.id), "Slide id"),
        presentationId,
        index: index(atPointer(item, mapping.slides.index), indexBase),
        text: lyricText, section,
      };
    });
    if (new Set(slides.map(slide => slide.id)).size !== slides.length ||
        new Set(slides.map(slide => slide.index)).size !== slides.length) {
      throw new Error("Slide catalog contains duplicate ids or indices");
    }
    return slides.sort((a, b) => a.index - b.index);
  }

  async triggerSlide(slide: SlideRef): Promise<void> {
    const { triggerSlide } = this.#profile.endpoints;
    const params = { presentationId: slide.presentationId, slideId: slide.id, index: slide.index + this.#profile.indexBase };
    await this.#client.request(
      triggerSlide.method, expandPath(triggerSlide.path, params), expandBody(triggerSlide.body, params),
    );
  }

  close(): void {}
}
