import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { runInputSchema, type Session } from '../../shared/contracts'
import { createProfileSchema } from '../../shared/catalog'

const storedSessionSchema = z.object({
  id: z.uuid(),
  workspace: z.string().min(1),
  threadId: z.string().min(1).optional(),
  projectId: z.uuid().optional(),
  createdAt: z.string(),
  runs: z.array(
    z.object({
      id: z.uuid(),
      prompt: z.string(),
      resolvedPrompt: z.string(),
      options: runInputSchema.omit({ prompt: true }),
      skillSnapshots: z.array(
        z.object({
          id: z.string(),
          path: z.string(),
          content: z.string(),
          name: z.string().optional(),
          projectId: z.string().nullable().optional(),
          originalPath: z.string().optional(),
          archivePath: z.string().optional(),
          files: z
            .array(
              z.object({
                path: z.string(),
                sha256: z.string(),
                size: z.number(),
              }),
            )
            .optional(),
        }),
      ),
      profileSnapshot: createProfileSchema
        .extend({
          id: z.uuid(),
          revision: z.number(),
          removedAt: z.string().nullable(),
          createdAt: z.string(),
          updatedAt: z.string(),
        })
        .optional(),
      projectSnapshot: z
        .object({
          id: z.uuid(),
          name: z.string(),
          description: z.string(),
          instructions: z.string(),
          devCommand: z.string(),
          testCommand: z.string(),
        })
        .optional(),
      startedAt: z.string(),
      finishedAt: z.string().optional(),
      status: z.enum([
        'running',
        'stopping',
        'completed',
        'cancelled',
        'failed',
        'interrupted',
      ]),
      items: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          title: z.string(),
          text: z.string(),
          status: z.string().optional(),
        }),
      ),
      events: z.array(
        z.object({ type: z.string(), at: z.string(), detail: z.string() }),
      ),
      error: z
        .object({ code: z.string(), message: z.string(), hint: z.string() })
        .optional(),
      usage: z
        .object({
          input_tokens: z.number(),
          output_tokens: z.number(),
          cached_input_tokens: z.number(),
        })
        .optional(),
    }),
  ),
})

export class SessionStore {
  private queue: Promise<void> = Promise.resolve()
  constructor(readonly directory: string) {}

  async read(): Promise<Session | undefined> {
    let text: string
    try {
      text = await readFile(join(this.directory, 'session.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    // Fail visibly on corrupt data; never silently replace conversation history.
    const envelope = z
      .object({ version: z.literal(1), session: storedSessionSchema })
      .parse(JSON.parse(text))
    return envelope.session
  }

  write(session: Session): Promise<void> {
    const text = JSON.stringify({ version: 1, session }, null, 2)
    const save = this.queue
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        const temporary = join(this.directory, 'session.json.tmp')
        await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, join(this.directory, 'session.json'))
      })
    this.queue = save
    return save
  }

  async archive(session: Session): Promise<void> {
    await this.queue.catch(() => {})
    await mkdir(join(this.directory, 'history'), {
      recursive: true,
      mode: 0o700,
    })
    await writeFile(
      join(this.directory, 'history', `${session.id}.json`),
      JSON.stringify({ version: 1, session }, null, 2),
      { mode: 0o600 },
    )
  }
}
