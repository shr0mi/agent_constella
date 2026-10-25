import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  repoPath: text('repo_path').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  instructions: text('instructions').notNull().default(''),
  devCommand: text('dev_command').notNull().default(''),
  testCommand: text('test_command').notNull().default(''),
  revision: integer('revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  acceptanceCriteria: text('acceptance_criteria').notNull().default(''),
  status: text('status', { enum: ['todo', 'doing', 'done'] })
    .notNull()
    .default('todo'),
  position: integer('position').notNull(),
  revision: integer('revision').notNull().default(1),
  archivedAt: text('archived_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const workspaceMeta = sqliteTable('workspace_meta', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
})
export const catalogSkills = sqliteTable('catalog_skills', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  folderPath: text('folder_path').notNull().unique(),
  revision: integer('revision').notNull().default(1),
  contentHash: text('content_hash').notNull(),
  removedAt: text('removed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const agentProfiles = sqliteTable('agent_profiles', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  roleInstructions: text('role_instructions').notNull(),
  styleGuide: text('style_guide').notNull(),
  skillIds: text('skill_ids', { mode: 'json' }).$type<string[]>().notNull(),
  model: text('model'),
  effort: text('effort', {
    enum: [
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
      'persistent',
    ],
  }),
  revision: integer('revision').notNull().default(1),
  removedAt: text('removed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
