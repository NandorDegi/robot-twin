/**
 * Vision /calib client for the wizard. Same origin only (/vision is proxied
 * by Caddy or Vite); every response is checked with zod before use.
 */
import {
  autotuneSchema,
  cameraInfoSchema,
  draftSchema,
  metricsSchema,
  referenceStatsSchema,
  saveResultSchema,
  squaresSchema,
  versionsSchema,
  visionOkSchema,
  visionStateSchema,
} from "@robot/protocol";

/** The part of a zod schema used here (the twin has no direct zod dependency). */
interface ZodType<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
}

export const VISION = `${location.origin}/vision`;

export class VisionError extends Error {}

async function parse<T>(res: Response, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new VisionError(`vision: HTTP ${res.status} (not JSON)`);
  }
  if (body && typeof body === "object" && (body as { ok?: unknown }).ok === false) {
    throw new VisionError(String((body as { error?: unknown }).error ?? "vision error"));
  }
  const r = schema.safeParse(body);
  if (!r.success) throw new VisionError(`vision: unexpected answer (${r.error.issues[0]?.path.join(".")}: ${r.error.issues[0]?.message})`);
  return r.data;
}

export async function vget<T>(path: string, schema: ZodType<T>): Promise<T> {
  const res = await fetch(`${VISION}${path}`, { credentials: "same-origin", cache: "no-store" });
  return parse(res, schema);
}

export async function vpost<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T> {
  const res = await fetch(`${VISION}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return parse(res, schema);
}

/** Draft fields come back merged into many answers (detect, corners, orientation). */
const draftAnswer = draftSchema;
const anyOk = visionOkSchema as ZodType<Record<string, any>>;

export const api = {
  state: () => vget("/calib/state", visionStateSchema),
  camera: () => vget("/calib/camera", cameraInfoSchema),
  setCamera: (b: unknown) => vpost("/calib/camera", b, cameraInfoSchema),
  metrics: () => vget("/calib/metrics", metricsSchema),
  detect: (method: string) => vpost("/calib/detect-board", { method }, draftAnswer),
  corners: (corners: [number, number][], mirroredCamera: boolean) =>
    vpost("/calib/corners", { corners, mirrored_camera: mirroredCamera }, draftAnswer),
  orientation: (b: { a1_index?: number; mirrored_camera?: boolean; confirm?: boolean; force?: boolean }) =>
    vpost("/calib/orientation", b, draftAnswer),
  captureReference: (frames: number) => vpost("/calib/reference", { frames }, referenceStatsSchema),
  reference: () => vget("/calib/reference", referenceStatsSchema),
  squares: () => vget("/calib/squares", squaresSchema),
  autotune: () => vpost("/calib/autotune", { expected: "start" }, autotuneSchema),
  thresholds: (t: { diff?: number; occupied_fraction?: number; white?: number }) => vpost("/calib/thresholds", t, anyOk),
  save: (b: unknown) => vpost("/calib/save", b, saveResultSchema),
  validate: (b: unknown) => vpost("/calib/validate", b, anyOk),
  versions: () => vget("/calib/versions", versionsSchema),
  rollback: (revision: number) => vpost("/calib/rollback", { revision }, anyOk),
  resetDraft: (from: "active" | "empty") => vpost("/calib/draft/reset", { from }, anyOk),
  scene: (b: unknown) => vpost("/calib/sim/scene", b, anyOk),
};
