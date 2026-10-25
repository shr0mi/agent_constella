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
] as const
