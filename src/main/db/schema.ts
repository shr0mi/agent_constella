import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { GraphDocument } from '../../shared/graph'
import type { NodeRun, TaskWorktree } from '../../shared/execution'
import type { WorkflowRecord, WorkflowDecision } from '../../shared/workflow'
import type { Effort } from '../../shared/contracts'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  repoPath: text('repo_path').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  instructions: text('instructions').notNull().default(''),
  devCommand: text('dev_command').notNull().default(''),
  testCommand: text('test_command').notNull().default(''),
  ideCommand: text('ide_command').notNull().default(''),
  maxParallelAgents: integer('max_parallel_agents').notNull().default(4),
  defaultModel: text('default_model'),
  defaultEffort: text('default_effort').$type<Effort>(),
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
  dependencyIds: text('dependency_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  requiredFiles: text('required_files', { mode: 'json' }).$type<string[]>().notNull().default([]),
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
export const taskGraphs = sqliteTable('task_graphs', {
  taskId: text('task_id')
    .primaryKey()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  document: text('document', { mode: 'json' }).$type<GraphDocument>().notNull(),
  preparedRevision: integer('prepared_revision'),
  preparedAt: text('prepared_at'),
  preparedFingerprint: text('prepared_fingerprint'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const graphRevisions = sqliteTable('graph_revisions', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  revision: integer('revision').notNull(),
  document: text('document', { mode: 'json' }).$type<GraphDocument>().notNull(),
  createdAt: text('created_at').notNull(),
})
export const graphCommands = sqliteTable('graph_commands', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  inputHash: text('input_hash').notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
})
export const taskWorktrees = sqliteTable('task_worktrees', {
  taskId: text('task_id')
    .primaryKey()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  document: text('document', { mode: 'json' }).$type<TaskWorktree>().notNull(),
})
export const nodeWorktrees = sqliteTable('node_worktrees', {
  nodeId: text('node_id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  document: text('document', { mode: 'json' }).$type<TaskWorktree>().notNull(),
})
export const nodeThreads = sqliteTable('node_threads', {
  nodeId: text('node_id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  threadId: text('thread_id'),
})
export const nodeRuns = sqliteTable('node_runs', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  startedAt: text('started_at').notNull(),
  document: text('document', { mode: 'json' }).$type<NodeRun>().notNull(),
})
export const workflows = sqliteTable('workflows', {
  taskId: text('task_id')
    .primaryKey()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  document: text('document', { mode: 'json' })
    .$type<WorkflowRecord>()
    .notNull(),
})
export const workflowDecisions = sqliteTable('workflow_decisions', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  document: text('document', { mode: 'json' })
    .$type<WorkflowDecision>()
    .notNull(),
})
