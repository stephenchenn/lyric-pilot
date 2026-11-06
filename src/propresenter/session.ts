import { errorMessage, type PresenterSnapshot, type ProPresenterAdapter, type Slide } from "./adapter.ts";
import type { EventLogger } from "../logging/logger.ts";

export type SnapshotListener = (snapshot: PresenterSnapshot) => void;
export type ControlAction = { type: "next" | "previous" } | { type: "goto"; slideId: string };
export interface ControlResult { target: Slide; confirmed: boolean; snapshot: PresenterSnapshot }

function position(snapshot: PresenterSnapshot): string {
  return JSON.stringify([snapshot.presentation?.id, snapshot.currentSlide]);
}

function comparable(snapshot: PresenterSnapshot): string {
  return JSON.stringify([snapshot.health.status, snapshot.health.message, position(snapshot)]);
}

/** One serial lane for reads and commands; interval ticks never build up. No automation. */
export class PresenterSession {
  readonly #adapter: ProPresenterAdapter;
  readonly #logger: EventLogger;
  readonly #allowControl: boolean;
  readonly #listeners = new Set<SnapshotListener>();
  #snapshot: PresenterSnapshot | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(adapter: ProPresenterAdapter, logger: EventLogger, allowControl = false) {
    this.#adapter = adapter;
    this.#logger = logger;
    this.#allowControl = allowControl;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #publish(snapshot: PresenterSnapshot, source: string): PresenterSnapshot {
    const previous = this.#snapshot;
    this.#snapshot = structuredClone(snapshot);
    if (!previous || comparable(previous) !== comparable(snapshot)) {
      this.#logger.log("state_changed", { source, snapshot });
      if (previous?.currentSlide && snapshot.currentSlide && position(previous) !== position(snapshot)) {
        this.#logger.log("slide_changed", {
          source, previous: previous.currentSlide, current: snapshot.currentSlide,
          // Polling observes a change, but cannot prove who caused it.
          attribution: source === "after-command" ? "observed-after-command" : "external-or-manual",
        });
      }
      for (const listener of this.#listeners) listener(structuredClone(snapshot));
    }
    return structuredClone(snapshot);
  }

  async #read(source = "poll", connect = false): Promise<PresenterSnapshot> {
    let snapshot: PresenterSnapshot;
    try {
      snapshot = await (connect ? this.#adapter.connect() : this.#adapter.getSnapshot());
    } catch (error) {
      snapshot = {
        health: { status: "disconnected", checkedAt: new Date().toISOString(), message: errorMessage(error) },
        presentation: null, currentSlide: null,
      };
    }
    return this.#publish(snapshot, source);
  }

  connect(): Promise<PresenterSnapshot> { return this.#serial(() => this.#read("connect", true)); }
  refresh(): Promise<PresenterSnapshot> { return this.#serial(() => this.#read()); }

  startPolling(intervalMs: number): () => void {
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void this.refresh().finally(() => { pending = false; }).catch(error => {
        // Endpoint failures are represented as snapshots. This catches observer/storage errors.
        process.stderr.write(`Polling stopped: ${errorMessage(error)}\n`);
        clearInterval(timer);
      });
    }, intervalMs);
    return () => { clearInterval(timer); };
  }

  listSlides(): Promise<Slide[]> {
    return this.#serial(async () => {
      const state = await this.#read();
      if (state.health.status !== "connected" || !state.presentation) {
        throw new Error(`Cannot read slides: ${state.health.message}`);
      }
      return this.#adapter.getSlides(state.presentation.id);
    });
  }

  control(action: ControlAction): Promise<ControlResult> {
    return this.#serial(async () => {
      let issued = false;
      try {
        if (this.#adapter.kind === "http" && !this.#allowControl) {
          throw new Error("Live controls are disabled. Use --allow-control only with your test presentation");
        }
        const before = await this.#read("before-command");
        if (before.health.status !== "connected" || !before.presentation || !before.currentSlide) {
          throw new Error(`Control blocked: no healthy, active slide (${before.health.message})`);
        }
        const slides = await this.#adapter.getSlides(before.presentation.id);
        if (slides.some(slide => slide.presentationId !== before.presentation!.id)) {
          throw new Error("Control blocked: slide catalog belongs to a different presentation");
        }
        const current = slides.findIndex(slide => slide.id === before.currentSlide!.id && slide.index === before.currentSlide!.index);
        if (current < 0) throw new Error("Control blocked: current slide is absent from the slide catalog");
        const target = action.type === "goto"
          ? slides.find(slide => slide.id === action.slideId)
          : slides[current + (action.type === "next" ? 1 : -1)];
        if (!target) throw new Error("No target slide in this presentation; boundary crossing is disabled");
        if (target.id === before.currentSlide.id) throw new Error("Target slide is already current");

        // A catalog request may be slow. Yield if a human moved the slide while it loaded.
        const preflight = await this.#read("before-command");
        if (preflight.health.status !== "connected" || position(preflight) !== position(before)) {
          throw new Error("Control cancelled: ProPresenter state changed during preparation; resync and try again");
        }
        this.#logger.log("control_requested", { action, target, mode: "manual", adapter: this.#adapter.kind });
        issued = true;
        await this.#adapter.triggerSlide(target);
        const snapshot = await this.#read("after-command");
        const confirmed = snapshot.health.status === "connected" &&
          snapshot.currentSlide?.id === target.id && snapshot.currentSlide.presentationId === target.presentationId &&
          snapshot.currentSlide.index === target.index;
        this.#logger.log("control_result", { action, target, confirmed, snapshot });
        return { target, confirmed, snapshot };
      } catch (error) {
        this.#logger.log("control_failed", {
          action, message: errorMessage(error), outcome: issued ? "unknown; never retried" : "not issued",
        });
        throw error;
      }
    });
  }
}
