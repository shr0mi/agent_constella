import { randomUUID } from 'node:crypto'
import type { WorkspaceDatabase } from '../db/database'
import type { ChangeEntry, ChangeRecord } from '../../shared/manager'

// Called inside the same transaction as the validated metadata mutation.
export function recordChange(
  database: WorkspaceDatabase,
  change: ChangeRecord,
) {
  const entry: ChangeEntry = {
    ...change,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    undoneAt: null,
  }
  database.sqlite
    .prepare(
      'INSERT INTO change_history (id, project_id, task_id, document) VALUES (?, ?, ?, ?)',
    )
    .run(entry.id, entry.projectId, entry.taskId, JSON.stringify(entry))
}
