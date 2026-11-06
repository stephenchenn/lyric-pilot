export interface PresentationRef {
  id: string;
  title: string;
}

export interface SlideRef {
  id: string;
  presentationId: string;
  /** Always zero based internally. The CLI displays index + 1. */
  index: number;
}

export interface Slide extends SlideRef {
  text: string;
  section: string | null;
}

export interface ConnectionHealth {
  status: "connected" | "disconnected" | "degraded";
  checkedAt: string;
  message: string;
}

export interface PresenterSnapshot {
  health: ConnectionHealth;
  presentation: PresentationRef | null;
  currentSlide: SlideRef | null;
}

/** Transport details and vendor response shapes stay behind this boundary. */
export interface ProPresenterAdapter {
  readonly kind: "mock" | "http";
  connect(): Promise<PresenterSnapshot>;
  getSnapshot(): Promise<PresenterSnapshot>;
  getSlides(presentationId: string): Promise<Slide[]>;
  triggerSlide(slide: SlideRef): Promise<void>;
  close(): void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
