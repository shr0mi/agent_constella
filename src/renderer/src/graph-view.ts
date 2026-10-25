import { z } from 'zod'
import type { GraphIdentity } from '../../shared/graph'

const point = z.object({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
})
const canvasViewSchema = z.object({
  positions: z.record(z.uuid(), point),
  viewport: z
    .object({
      x: z.number().finite().min(-1_000_000).max(1_000_000),
      y: z.number().finite().min(-1_000_000).max(1_000_000),
      zoom: z.number().min(0.1).max(2.5),
    })
    .optional(),
})
export type GraphCanvasView = z.infer<typeof canvasViewSchema>
const key = (identity: GraphIdentity) =>
  `constella:graph-view:${identity.projectId}:${identity.taskId}`

export function readGraphView(identity: GraphIdentity): GraphCanvasView {
  try {
    return canvasViewSchema.parse(
      JSON.parse(localStorage.getItem(key(identity)) ?? 'null'),
    )
  } catch {
    return { positions: {} }
  }
}
export function writeGraphView(identity: GraphIdentity, view: GraphCanvasView) {
  try {
    localStorage.setItem(key(identity), JSON.stringify(view))
  } catch {
    // Browsing the canvas remains available if local preferences cannot be stored.
  }
}
