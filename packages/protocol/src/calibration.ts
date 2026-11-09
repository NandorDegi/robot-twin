/**
 * Calibration wizard: the calibration file (written by apps/vision, read by
 * apps/server), the vision /calib responses the twin reads, and the robot-frame
 * WebSocket messages. Everything that crosses a process boundary is checked
 * with zod.
 */
import { z } from "zod";

const finite = z.number().finite();
const vec3 = z.tuple([finite, finite, finite]);
const px = z.tuple([finite, finite]);

export const CALIBRATION_SCHEMA = "robot-twin.calibration/1";

export const thresholdsSchema = z.object({
  diff: finite.min(1).max(254),
  occupied_fraction: finite.min(0.01).max(0.95),
  white: finite.min(1).max(254),
});
export type Thresholds = z.infer<typeof thresholdsSchema>;

export const validationSchema = z.object({
  passed: z.boolean(),
  revision: z.number().int(),
  date: z.string().optional(),
  start_position: z
    .object({ correct: z.number(), total: z.number(), pieces_correct: z.number(), pieces_total: z.number(), errors: z.array(z.string()) })
    .optional(),
  reachability: z.object({ reachable: z.number(), total: z.number(), unreachable: z.array(z.string()) }).optional(),
});

export const robotPoseSchema = z.object({
  origin_twin_mm: vec3,
  rotation_deg: finite.min(-180).max(180),
  square_mm: finite.min(10).max(100),
  a1_corner_base_mm: vec3.optional(),
  method: z.string().optional(),
  residual_mm: finite.nullable().optional(),
});

/** The calibration file (one source of truth, see apps/vision/vision/calib.py). */
export const calibrationFileSchema = z.object({
  schema: z.literal(CALIBRATION_SCHEMA),
  revision: z.number().int().positive(),
  created: z.string(),
  operator_note: z.string().optional(),
  rolled_back_from: z.number().int().nullable().optional(),
  camera: z.object({ source: z.string(), width: z.number(), height: z.number() }).passthrough().optional(),
  board: z
    .object({
      square_mm: finite.min(10).max(100),
      homography: z.array(z.array(finite).length(3)).length(3),
      orientation: z.object({ confirmed: z.boolean(), mirrored_camera: z.boolean().optional() }).passthrough(),
    })
    .passthrough(),
  reference: z.object({ image: z.string().min(1) }).passthrough(),
  thresholds: thresholdsSchema,
  robot: robotPoseSchema,
  validation: validationSchema.optional(),
});
export type CalibrationFile = z.infer<typeof calibrationFileSchema>;

// --- vision /calib responses (the twin reads these) -----------------------------

export const visionErrorSchema = z.object({ ok: z.literal(false), error: z.string() });
/** Any successful answer (fields checked by the caller where they matter). */
export const visionOkSchema = z.object({ ok: z.literal(true) }).passthrough();

export const overlaySchema = z.object({
  lines: z.array(z.tuple([px, px])),
  centres: z.record(px),
  corners: z.record(px),
});

export const draftSchema = z
  .object({
    square_mm: finite,
    method: z.string().nullable(),
    raw_corners: z.array(px).length(4).nullable(),
    a1_index: z.number().int(),
    mirrored_camera: z.boolean(),
    labelled: z.record(px).nullable(),
    confirmed: z.boolean(),
    grid_error: z
      .object({ mean_px: finite.nullable(), max_px: finite.nullable(), points: z.number(), square_px: finite, mean_mm: finite.optional() })
      .nullable(),
    a1_dark: z.boolean().nullable(),
    markers: z.array(z.object({ id: z.number(), centre: px })),
    notes: z.array(z.string()),
    has_reference: z.boolean(),
    reference_frames: z.number(),
    thresholds: thresholdsSchema,
    overlay: overlaySchema.nullable(),
  })
  .passthrough();
export type Draft = z.infer<typeof draftSchema>;

export const activeStatusSchema = z
  .object({
    file: z.string(),
    revision: z.number().nullable(),
    created: z.string().nullable(),
    note: z.string().nullable(),
    complete: z.boolean(),
    reasons: z.array(z.string()),
  })
  .passthrough();

export const visionStateSchema = z.object({
  ok: z.literal(true),
  draft: draftSchema,
  active: activeStatusSchema,
  frame: z.object({ width: z.number(), height: z.number() }),
  synthetic: z.boolean(),
});

export const cameraInfoSchema = z
  .object({
    ok: z.literal(true),
    source: z.union([z.string(), z.number()]),
    width: z.number(),
    height: z.number(),
    available: z.boolean(),
    synthetic: z.boolean(),
    controls: z.record(z.number().nullable()),
    controls_set: z.record(z.number()),
    cameras: z.array(z.object({ index: z.union([z.number(), z.string()]), device: z.string(), name: z.string() })),
    resolutions: z.array(z.tuple([z.number(), z.number()])),
  })
  .passthrough();

export const metricsSchema = z.object({
  ok: z.literal(true),
  brightness: finite,
  focus: finite,
  clipped: finite,
  dark: finite,
  width: z.number(),
  height: z.number(),
  board_roi: z.boolean(),
  warnings: z.array(z.string()),
});

export const referenceStatsSchema = z.object({
  ok: z.literal(true),
  frames: z.number(),
  squares: z.record(
    z.object({ mean: finite, std: finite, clipped: finite, temporal_std: finite.nullable(), dark: z.boolean(), flags: z.array(z.string()) }),
  ),
  warnings: z.array(z.string()),
  light_median: finite,
  dark_median: finite,
  contrast: finite,
});

const squareState = z.enum(["w", "b"]).nullable();

export const squaresSchema = z.object({
  ok: z.literal(true),
  squares: z.record(squareState),
  details: z.record(z.object({ frac: finite, grey: finite.nullable(), confidence: finite })),
  thresholds: thresholdsSchema,
  low_confidence: z.array(z.string()),
});

export const autotuneSchema = z.object({
  ok: z.literal(true),
  thresholds: thresholdsSchema,
  correct: z.number(),
  total: z.number(),
  pieces_correct: z.number(),
  pieces_total: z.number(),
  errors: z.array(z.string()),
  occupancy_margin: finite,
  colour_margin: finite,
});

export const versionsSchema = z.object({
  ok: z.literal(true),
  active: activeStatusSchema,
  versions: z.array(
    z.object({ revision: z.number(), created: z.string().nullable(), note: z.string().nullable(), passed: z.boolean(), rolled_back_from: z.number().nullable() }),
  ),
});

export const saveResultSchema = z.object({
  ok: z.literal(true),
  saved: z.object({ revision: z.number() }).passthrough(),
  status: activeStatusSchema,
});

// --- robot-frame step: WebSocket messages ------------------------------------------

export const touchPointSchema = z.enum(["a1", "h1", "h8"]);
const squareSchema = z.string().regex(/^[a-h][1-8]$/);

/** Move the hand (pointing down) above a square of the CONFIGURED board pose. */
export const calibGotoSchema = z.object({
  type: z.literal("calibGoto"),
  square: squareSchema,
  /** Height of the TCP above the board surface (mm). */
  heightMm: z.number().finite().min(5).max(200),
  /** Must be true for a real robot: the operator confirmed the motion. */
  confirmReal: z.boolean().optional(),
});
/** Jog the TCP in the robot BASE frame (X forward, Y left, Z up), at most 10 mm per axis. */
export const calibNudgeSchema = z.object({
  type: z.literal("calibNudge"),
  deltaBaseMm: z.tuple([
    z.number().finite().min(-10).max(10),
    z.number().finite().min(-10).max(10),
    z.number().finite().min(-10).max(10),
  ]),
  confirmReal: z.boolean().optional(),
});
/** Record the current TCP (from the measured joint state) as a touch-off point. */
export const calibRecordSchema = z.object({ type: z.literal("calibRecord"), point: touchPointSchema });
export const calibFitSchema = z.object({
  type: z.literal("calibFit"),
  hoverMm: z.number().finite().min(0).max(200),
  /** Keep the nominal square size (default) or use the fitted one. */
  useFittedSquare: z.boolean().optional(),
});
export const calibManualPoseSchema = z.object({
  type: z.literal("calibManualPose"),
  origin: vec3.refine((v) => v.every((x) => Math.abs(x) < 2000), "origin out of range"),
  rotationDeg: z.number().finite().min(-180).max(180),
  square: z.number().finite().min(10).max(100),
});
export const calibResetSchema = z.object({ type: z.literal("calibReset") });
/** Re-read the calibration file and apply it (after a save or a rollback). */
export const calibReloadSchema = z.object({ type: z.literal("calibReload") });
/** Final check of the active calibration: reachability + start position. */
export const calibValidateSchema = z.object({ type: z.literal("calibValidate") });
/** Move the arm to the observe pose (out of the camera view). */
export const calibObservePoseSchema = z.object({ type: z.literal("calibObservePose"), confirmReal: z.boolean().optional() });

export const calibClientSchemas = [
  calibGotoSchema,
  calibNudgeSchema,
  calibRecordSchema,
  calibFitSchema,
  calibManualPoseSchema,
  calibResetSchema,
  calibReloadSchema,
  calibValidateSchema,
  calibObservePoseSchema,
] as const;

export type CalibClientMessage =
  | z.infer<typeof calibGotoSchema>
  | z.infer<typeof calibNudgeSchema>
  | z.infer<typeof calibRecordSchema>
  | z.infer<typeof calibFitSchema>
  | z.infer<typeof calibManualPoseSchema>
  | z.infer<typeof calibResetSchema>
  | z.infer<typeof calibReloadSchema>
  | z.infer<typeof calibValidateSchema>
  | z.infer<typeof calibObservePoseSchema>;

export interface WireBoardPose {
  origin: [number, number, number];
  rotationDeg: number;
  square: number;
}

export interface WireFit {
  pose: WireBoardPose;
  fittedSquare: number;
  residualRms: number;
  residualMax: number;
  perPoint: Record<string, number>;
  heightSpread: number;
  mirrored: boolean;
  warnings: string[];
  method: "touch-off" | "manual";
  reachability: { reachable: number; total: number; unreachable: string[] };
  /** Difference to the configured (active) pose. */
  delta: { originMm: number; rotationDeg: number; squareMm: number };
  hoverMm?: number;
  points?: Record<string, [number, number, number]>;
}

export type CalibServerMessage =
  | {
      type: "calibRobot";
      points: Record<string, [number, number, number]>;
      /** Current TCP, twin frame (mm). */
      tcp: [number, number, number];
      configured: WireBoardPose;
      fit: WireFit | null;
      message: string;
      real: boolean;
    }
  | {
      type: "calibStatus";
      /** The chess loop needs a valid calibration (it refuses without one). */
      required: boolean;
      valid: boolean;
      reasons: string[];
      revision: number | null;
      file: string;
      boardPose: WireBoardPose | null;
      validation: z.infer<typeof validationSchema> | null;
    };
