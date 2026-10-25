import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ApplicationError } from '../application/errors'
import { migrations } from './migrations'
import * as schema from './schema'

export function openWorkspaceDatabase(file: string) {
  if (file !== ':memory:')
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const sqlite = new Database(file)
  try {
    if (file !== ':memory:' && process.platform !== 'win32')
      chmodSync(file, 0o600)
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('busy_timeout = 5000')
    sqlite.exec(
      'CREATE TABLE IF NOT EXISTS app_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
    )
    sqlite
      .transaction(() => {
        const applied = sqlite
          .prepare(
            'SELECT version, checksum FROM app_schema_migrations ORDER BY version',
          )
          .all() as { version: number; checksum: string }[]
        if (applied.some((row) => row.version > migrations.length))
          throw new ApplicationError(
            'DATABASE_VERSION',
            'This database was created by a newer version of AgentConstella.',
            'Open it with the newer app. This version will not downgrade or replace your data.',
          )
        for (const migration of migrations) {
          const checksum = createHash('sha256')
            .update(migration.sql)
            .digest('hex')
          const existing = applied.find(
            (row) => row.version === migration.version,
          )
          if (existing) {
            if (existing.checksum !== checksum)
              throw new ApplicationError(
                'MIGRATION_CHANGED',
                `Applied database migration ${migration.version} has changed.`,
                'Restore the original migration and add a new migration for schema changes. The database is preserved.',
              )
            continue
          }
          sqlite.exec(migration.sql)
          sqlite
            .prepare(
              'INSERT INTO app_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
            )
            .run(
              migration.version,
              migration.name,
              checksum,
              new Date().toISOString(),
            )
        }
      })
      .immediate()
    return {
      sqlite,
      db: drizzle(sqlite, { schema }),
      close: () => sqlite.close(),
    }
  } catch (error) {
    sqlite.close()
    throw error
  }
}
export type WorkspaceDatabase = ReturnType<typeof openWorkspaceDatabase>
