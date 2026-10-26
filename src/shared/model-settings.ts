import type { Effort } from './contracts'

export interface ModelSettings {
  model?: string | null
  effort?: Effort | null
}
export interface ProjectModelDefaults {
  defaultModel?: string | null
  defaultEffort?: Effort | null
}

// Undefined inherits. An explicit null override selects the runtime/model default.
// Keep each inherited effort paired with the model that supports it.
export function resolveModelSettings(
  override: ModelSettings,
  profile?: ModelSettings,
  project?: ProjectModelDefaults,
): { model?: string; effort?: Effort } {
  const inheritedModel = profile?.model ?? project?.defaultModel ?? undefined
  const inheritedEffort = profile?.model
    ? (profile.effort ?? undefined)
    : (project?.defaultEffort ?? undefined)
  return {
    model:
      override.model !== undefined
        ? (override.model ?? undefined)
        : inheritedModel,
    effort:
      override.effort !== undefined
        ? (override.effort ?? undefined)
        : override.model === undefined || override.model === inheritedModel
          ? inheritedEffort
          : undefined,
  }
}
