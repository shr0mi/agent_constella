// Append migrations; never edit an applied migration. SQL is embedded in the main
// bundle so dev, preview, and future packaged builds use the same migration set.
export const migrations = [
  {
    version: 1,
    name: 'projects_and_kanban',
    sql: `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      repo_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL CHECK(length(name) > 0),
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      dev_command TEXT NOT NULL DEFAULT '',
      test_command TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK(length(title) > 0),
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'doing', 'done')),
      position INTEGER NOT NULL CHECK(position >= 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX tasks_board_order ON tasks(project_id, archived_at, status, position);
    CREATE TABLE workspace_meta (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      revision INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO workspace_meta (id, revision) VALUES (1, 0);
  `,
  },
  {
    version: 2,
    name: 'skill_and_agent_catalogs',
    sql: `
    CREATE TABLE catalog_skills (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      folder_path TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      content_hash TEXT NOT NULL,
      removed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX catalog_skill_scope_name ON catalog_skills(COALESCE(project_id, ''), name);
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role_instructions TEXT NOT NULL DEFAULT '',
      style_guide TEXT NOT NULL DEFAULT '',
      skill_ids TEXT NOT NULL CHECK(json_valid(skill_ids)),
      model TEXT,
      effort TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      removed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX agent_profile_scope ON agent_profiles(project_id, removed_at);
  `,
  },
  {
    version: 3,
    name: 'task_graphs_and_revisions',
    sql: `
    CREATE TABLE task_graphs (
      task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision > 0),
      document TEXT NOT NULL CHECK(json_valid(document)),
      prepared_revision INTEGER,
      prepared_at TEXT,
      prepared_fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE graph_revisions (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      document TEXT NOT NULL CHECK(json_valid(document)),
      created_at TEXT NOT NULL,
      UNIQUE(task_id, revision)
    );
    CREATE TABLE graph_commands (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX graph_revisions_task ON graph_revisions(task_id, revision);
  `,
  },
  {
    version: 4,
    name: 'task_worktrees_and_node_runs',
    sql: `
    CREATE TABLE task_worktrees (
      task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      document TEXT NOT NULL CHECK(json_valid(document))
    );
    CREATE TABLE node_threads (
      node_id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      thread_id TEXT
    );
    CREATE TABLE node_runs (
      id TEXT PRIMARY KEY NOT NULL,
      node_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      document TEXT NOT NULL CHECK(json_valid(document))
    );
    CREATE INDEX node_runs_history ON node_runs(project_id, task_id, node_id, started_at);
  `,
  },
  {
    version: 5,
    name: 'workflow_scheduling_and_decisions',
    sql: `
    CREATE TABLE workflows (
      task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      document TEXT NOT NULL CHECK(json_valid(document))
    );
    CREATE TABLE workflow_decisions (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      document TEXT NOT NULL CHECK(json_valid(document))
    );
    CREATE INDEX workflow_project ON workflows(project_id);
    CREATE INDEX workflow_decisions_task ON workflow_decisions(task_id);
  `,
  },
  {
    version: 6,
    name: 'manager_chats_and_change_history',
    sql: `
    CREATE TABLE manager_chats (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      document TEXT NOT NULL CHECK(json_valid(document))
    );
    CREATE UNIQUE INDEX manager_chat_scope ON manager_chats(project_id, COALESCE(task_id, ''));
    CREATE TABLE change_history (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      document TEXT NOT NULL CHECK(json_valid(document))
    );
    CREATE INDEX change_history_scope ON change_history(project_id, task_id);
    CREATE TABLE manager_commands (
      id TEXT PRIMARY KEY NOT NULL,
      input_hash TEXT NOT NULL,
      result TEXT NOT NULL CHECK(json_valid(result))
    );
    `,
  },
  {
    version: 7,
    name: 'project_model_defaults',
    sql: `
    ALTER TABLE projects ADD COLUMN default_model TEXT;
    ALTER TABLE projects ADD COLUMN default_effort TEXT CHECK(default_effort IS NULL OR default_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'));
    `,
  },
  {
    version: 8,
    name: 'project_settings_change_history',
    sql: `
    ALTER TABLE change_history RENAME TO change_history_previous;
    CREATE TABLE change_history (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      document TEXT NOT NULL CHECK(json_valid(document))
    );
    INSERT INTO change_history (id, project_id, task_id, document)
      SELECT id, project_id, task_id, document FROM change_history_previous ORDER BY rowid;
    DROP TABLE change_history_previous;
    CREATE INDEX change_history_scope ON change_history(project_id, task_id);
    `,
  },
  {
    version: 9,
    name: 'manager_conversation_history',
    sql: `
    DROP INDEX manager_chat_scope;
    ALTER TABLE manager_chats ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1));
    ALTER TABLE manager_chats ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
    UPDATE manager_chats SET created_at = COALESCE(json_extract(document, '$.turns[0].startedAt'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    CREATE UNIQUE INDEX manager_chat_scope ON manager_chats(project_id, COALESCE(task_id, '')) WHERE is_current = 1;
    CREATE INDEX manager_chat_history ON manager_chats(project_id, task_id);
    `,
  },
  {
    version: 10,
    name: 'project_scoped_manager_receipts',
    sql: `
    ALTER TABLE manager_commands ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
    UPDATE manager_commands SET project_id = (
      SELECT id FROM projects WHERE id = COALESCE(
        json_extract(manager_commands.result, '$.projectId'),
        json_extract(manager_commands.result, '$.task.projectId'),
        json_extract(manager_commands.result, '$.project.id'),
        (SELECT id FROM projects WHERE id = json_extract(manager_commands.result, '$.id')),
        (SELECT project_id FROM change_history WHERE id = json_extract(manager_commands.result, '$.undone'))
      )
    );
    CREATE INDEX manager_commands_project ON manager_commands(project_id);
    `,
  },
  {
    version: 11,
    name: 'parallel_workspaces_and_task_dependencies',
    sql: `
    ALTER TABLE projects ADD COLUMN ide_command TEXT NOT NULL DEFAULT '';
    ALTER TABLE projects ADD COLUMN max_parallel_agents INTEGER NOT NULL DEFAULT 4 CHECK(max_parallel_agents BETWEEN 1 AND 8);
    ALTER TABLE tasks ADD COLUMN dependency_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(dependency_ids));
    ALTER TABLE tasks ADD COLUMN required_files TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_files));
    CREATE TABLE node_worktrees (
      node_id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      document TEXT NOT NULL CHECK(json_valid(document))
    );
    UPDATE tasks SET status = 'doing', revision = revision + 1
    WHERE status = 'done' AND id IN (
      SELECT task_id FROM workflows WHERE json_extract(document, '$.startedAt') IS NOT NULL
      AND COALESCE(json_extract(document, '$.integration.status'), '') != 'integrated'
    );
    `,
  },
] as const
