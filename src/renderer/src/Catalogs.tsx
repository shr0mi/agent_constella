import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Archive,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Copy,
  FileCode2,
  FolderInput,
  Globe2,
  Layers3,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  X,
  Zap,
} from 'lucide-react'
import type {
  AgentProfile,
  CatalogSkill,
  CatalogSnapshot,
  SkillDocument,
} from '../../shared/catalog'
import type { Effort, Failure } from '../../shared/contracts'
import { Modal, TimedUndoButton } from './components/Modal'
import { ModelFields, SkillSelector } from './components/CatalogSelectors'
import { catalogAction, useCatalog, useCatalogStore } from './catalog-store'
import { useAppStore } from './store'
import { useWorkspaceStore } from './workspace-store'

export function CatalogPage({ kind }: { kind: 'skills' | 'profiles' }) {
  const projects = useWorkspaceStore((state) => state.snapshot?.projects)
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState<'global' | 'project'>(
    searchParams.get('project') ? 'project' : 'global',
  )
  const [selectedProject, setSelectedProject] = useState(
    searchParams.get('project') ?? '',
  )
  const projectId =
    tab === 'project' ? selectedProject || projects?.[0]?.id || null : null
  const validScope = tab === 'global' || !!projectId
  const project = projects?.find((project) => project.id === projectId)
  const { snapshot, loading, refresh } = useCatalog(projectId)
  const busy = useCatalogStore((state) => state.pending > 0)
  const [search, setSearch] = useState('')
  const [removed, setRemoved] = useState(false)
  const [newSkill, setNewSkill] = useState(false)
  const [skillDocument, setSkillDocument] = useState<SkillDocument>()
  const [profileEditor, setProfileEditor] = useState<AgentProfile | 'new'>()
  const [detailId, setDetailId] = useState<string>()
  useEffect(() => {
    setDetailId(undefined)
    setNewSkill(false)
    setSkillDocument(undefined)
    setProfileEditor(undefined)
    setSearch('')
  }, [projectId, kind])
  const records = validScope
    ? (kind === 'skills'
        ? (snapshot?.skills ?? [])
        : (snapshot?.profiles ?? [])
      ).filter(
        (item) =>
          item.projectId === projectId &&
          !!item.removedAt === removed &&
          `${item.name} ${'description' in item ? item.description : item.roleInstructions}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      )
    : []
  const detail = (
    kind === 'skills' ? (snapshot?.skills ?? []) : (snapshot?.profiles ?? [])
  ).find((item) => item.id === detailId) as CatalogSkill | AgentProfile | undefined
  function edit(item: CatalogSkill | AgentProfile) {
    setDetailId(undefined)
    if ('folderPath' in item) void editSkill(item)
    else setProfileEditor(item)
  }
  async function importSkill() {
    try {
      await catalogAction((api) => api.importSkill({ projectId }))
    } catch {
      /* Shared error notice describes the import failure. */
    }
  }
  async function editSkill(skill: CatalogSkill) {
    try {
      setSkillDocument(
        await catalogAction((api) => api.getSkill({ projectId, id: skill.id })),
      )
    } catch {
      /* Keep the catalog usable when a folder is missing. */
    }
  }
  async function toggle(item: CatalogSkill | AgentProfile) {
    const input = {
      projectId,
      id: item.id,
      expectedRevision: item.revision,
      active: !!item.removedAt,
    }
    try {
      if ('folderPath' in item)
        await catalogAction((api) => api.setSkillActive(input))
      else await catalogAction((api) => api.setProfileActive(input))
    } catch {
      /* The shared notice explains blocked removals and restores. */
    }
  }
  function chooseTab(value: 'global' | 'project') {
    setTab(value)
    setSearchParams(
      value === 'project' && (selectedProject || projects?.[0]?.id)
        ? { project: selectedProject || projects![0].id }
        : {},
    )
  }
  return (
    <main className="catalog-page">
      <div className="page-heading">
        <div>
          <h1>
            {kind === 'skills'
              ? 'Skills, ready to reuse.'
              : 'A role for every kind of work.'}
          </h1>
          <p>
            {kind === 'skills'
              ? 'Reusable instructions and resources, available where you need them.'
              : 'Give an agent its instructions, style, skills, and model defaults.'}
          </p>
        </div>
        <div className="heading-actions">
          {kind === 'skills' && (
            <button
              className="button secondary"
              disabled={busy || !validScope}
              onClick={() => void importSkill()}
            >
              <FolderInput size={14} />
              Import folder
            </button>
          )}
          <button
            className="button primary"
            disabled={busy || !validScope}
            onClick={() =>
              kind === 'skills' ? setNewSkill(true) : setProfileEditor('new')
            }
          >
            <Plus size={15} />
            {kind === 'skills' ? 'Create skill' : 'New profile'}
          </button>
        </div>
      </div>
      <div className="catalog-scope-bar">
        <div className="scope-tabs" role="tablist" aria-label="Catalog scope">
          <button
            role="tab"
            aria-selected={tab === 'global'}
            className={tab === 'global' ? 'selected' : ''}
            onClick={() => chooseTab('global')}
          >
            <Globe2 size={14} />
            Global
          </button>
          <button
            role="tab"
            aria-selected={tab === 'project'}
            className={tab === 'project' ? 'selected' : ''}
            onClick={() => chooseTab('project')}
          >
            <Layers3 size={14} />
            Project
          </button>
        </div>
        {tab === 'project' && (
          <div className="select-wrap catalog-project-select">
            <select
              aria-label="Catalog project"
              value={projectId ?? ''}
              disabled={!projects?.length}
              onChange={(event) => {
                setSelectedProject(event.target.value)
                setSearchParams({ project: event.target.value })
              }}
            >
              {!projects?.length && <option value="">No projects yet</option>}
              {projects?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <ChevronDown size={13} />
          </div>
        )}
        <span className="catalog-scope-caption">
          {tab === 'global'
            ? 'Available across all projects'
            : project
              ? `Only in ${project.name}`
              : 'Choose a project to continue'}
        </span>
      </div>
      <div className="catalog-toolbar">
        <span>
          {removed
            ? 'REMOVED ITEMS'
            : kind === 'skills'
              ? 'SKILL FOLDERS'
              : 'AGENT PROFILES'}
          <small>{records.length}</small>
        </span>
        <span />
        <label className="catalog-show-removed">
          <input
            type="checkbox"
            checked={removed}
            onChange={(event) => setRemoved(event.target.checked)}
          />
          Show removed
        </label>
        <label className="workspace-search">
          <Search size={14} />
          <input
            aria-label="Search catalog"
            placeholder="Find in this scope…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {!validScope ? (
        <div className="workspace-empty">
          <Layers3 size={30} />
          <h2>A project gives local items a home.</h2>
          <p>Create or open a project to start its own catalog.</p>
          <Link to="/projects" className="button secondary">
            Open projects
            <ArrowRight size={13} />
          </Link>
        </div>
      ) : loading && !snapshot ? (
        <div className="workspace-empty">
          <LoaderCircle size={24} className="spin" />
          <p>Loading this catalog…</p>
        </div>
      ) : !snapshot ? (
        <div className="workspace-empty">
          <h2>Catalog could not be loaded</h2>
          <button className="button secondary" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : records.length === 0 ? (
        <div className="workspace-empty catalog-empty">
          {kind === 'skills' ? <Zap size={32} /> : <Bot size={32} />}
          <h2>
            {removed
              ? 'No removed items here.'
              : kind === 'skills'
                ? 'Teach a repeatable workflow.'
                : 'Build your first agent profile.'}
          </h2>
          <p>
            {removed
              ? 'Removed items stay on disk and can be restored from this view.'
              : kind === 'skills'
                ? 'Create a skill or import a folder with SKILL.md and its resources.'
                : 'Combine role instructions, a style guide, and scoped skills into a reusable profile.'}
          </p>
        </div>
      ) : (
        <div className="catalog-grid">
          {records.map((item) => (
            <article
              key={item.id}
              className={`catalog-card is-clickable ${item.removedAt ? 'removed' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`Open ${item.name}`}
              onClick={() => setDetailId(item.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setDetailId(item.id)
                }
              }}
            >
              <div className="catalog-card-top">
                <span className="catalog-symbol">
                  {kind === 'skills' ? <Zap size={18} /> : <Bot size={19} />}
                </span>
                <span className="catalog-scope-chip">
                  {item.projectId ? 'Project' : 'Global'}
                </span>
                <div className="card-hover-actions">
                  <button
                    type="button"
                    className="icon-button"
                    title="Edit"
                    aria-label={`Edit ${item.name}`}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation()
                      edit(item)
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title={item.removedAt ? 'Restore' : 'Remove'}
                    aria-label={`${item.removedAt ? 'Restore' : 'Remove'} ${item.name}`}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation()
                      void toggle(item)
                    }}
                  >
                    {item.removedAt ? <RotateCcw size={13} /> : <Archive size={13} />}
                  </button>
                </div>
              </div>
              <h2>{item.name}</h2>
              <p className="catalog-card-description clamp-2">
                {'description' in item
                  ? item.description
                  : item.roleInstructions ||
                    'Add role instructions to guide this agent.'}
              </p>
              {!('folderPath' in item) && (
                <div className="profile-card-tags">
                  <span>
                    <Zap size={11} />
                    {item.skillIds.length} skills
                  </span>
                  <span>{item.model ?? 'Default model'}</span>
                </div>
              )}
              <span className="card-open-hint">
                Details <ArrowRight size={12} />
              </span>
            </article>
          ))}
        </div>
      )}
      <div
        className="catalog-footnote"
        title={
          kind === 'skills'
            ? tab === 'global'
              ? 'Global skill folders are saved in app data.'
              : 'Project skill folders are saved under .agents/skills/.'
            : 'A global profile can select global skills; a project profile can also select its local skills.'
        }
      >
        <Check size={12} />
        Saved on this device
      </div>
      {detail && (
        <CatalogDetail
          item={detail}
          skills={snapshot?.skills ?? []}
          busy={busy}
          onClose={() => setDetailId(undefined)}
          onEdit={() => edit(detail)}
          onToggle={() => void toggle(detail)}
        />
      )}
      {newSkill && (
        <CreateSkillEditor
          projectId={projectId}
          scopeName={project?.name}
          onClose={() => setNewSkill(false)}
        />
      )}
      {skillDocument && (
        <SkillEditor
          document={skillDocument}
          projectId={projectId}
          onClose={() => setSkillDocument(undefined)}
        />
      )}
      {profileEditor && (
        <ProfileEditor
          key={profileEditor === 'new' ? 'new' : profileEditor.id}
          profile={profileEditor === 'new' ? undefined : profileEditor}
          snapshot={snapshot!}
          projectId={projectId}
          scopeName={project?.name}
          onClose={() => setProfileEditor(undefined)}
        />
      )}
    </main>
  )
}

function CatalogDetail({
  item,
  skills,
  busy,
  onClose,
  onEdit,
  onToggle,
}: {
  item: CatalogSkill | AgentProfile
  skills: CatalogSkill[]
  busy: boolean
  onClose: () => void
  onEdit: () => void
  onToggle: () => void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const isSkill = 'folderPath' in item
  return (
    <>
      <div className="detail-scrim" onClick={onClose} />
      <aside className="detail-panel" aria-label={`${item.name} details`}>
        <header>
          <span className="catalog-symbol">
            {isSkill ? <Zap size={18} /> : <Bot size={19} />}
          </span>
          <div>
            <h2>{item.name}</h2>
            <span className="catalog-scope-chip">
              {item.projectId ? 'Project' : 'Global'} · v{item.revision}
              {item.removedAt ? ' · removed' : ''}
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close details"
          >
            <X size={16} />
          </button>
        </header>
        <div className="detail-body">
          <section>
            <h3>{isSkill ? 'What it does' : 'Role'}</h3>
            <p>
              {isSkill
                ? item.description
                : item.roleInstructions || 'No role instructions yet.'}
            </p>
          </section>
          {isSkill ? (
            <>
              {item.source && (
                <section>
                  <h3>Source</h3>
                  <dl className="detail-facts">
                    <div>
                      <dt>Repository</dt>
                      <dd>
                        <span title={item.source.url}>{item.source.repository}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>License</dt>
                      <dd>{item.source.license}</dd>
                    </div>
                    <div>
                      <dt>Revision</dt>
                      <dd className="mono-meta">{item.source.revision.slice(0, 8)}</dd>
                    </div>
                  </dl>
                </section>
              )}
              <section>
                <h3>Folder</h3>
                <div className="detail-path">
                  <code title={item.folderPath}>{item.folderPath}</code>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Copy folder path"
                    onClick={() => {
                      void navigator.clipboard?.writeText(item.folderPath)
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1400)
                    }}
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
              </section>
            </>
          ) : (
            <>
              <section>
                <h3>Skills · {item.skillIds.length}</h3>
                {item.skillIds.length ? (
                  <div className="detail-chips">
                    {item.skillIds.map((id) => (
                      <span key={id}>
                        <Zap size={11} />
                        {skills.find((skill) => skill.id === id)?.name ?? id}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p>No skills selected.</p>
                )}
              </section>
              <section>
                <h3>Model</h3>
                <dl className="detail-facts">
                  <div>
                    <dt>Model</dt>
                    <dd>{item.model ?? 'Default'}</dd>
                  </div>
                  <div>
                    <dt>Effort</dt>
                    <dd>{item.effort ?? 'Default'}</dd>
                  </div>
                </dl>
              </section>
              {item.styleGuide && (
                <section>
                  <h3>Style guide</h3>
                  <p className="clamp-6">{item.styleGuide}</p>
                </section>
              )}
            </>
          )}
        </div>
        <footer>
          {item.removedAt ? (
            <button
              type="button"
              className="button catalog-remove"
              disabled={busy}
              onClick={onToggle}
            >
              <RotateCcw size={13} />
              Restore
            </button>
          ) : (
            <TimedUndoButton
              label="Remove"
              icon={<Archive size={13} />}
              pendingLabel="Removing"
              disabled={busy}
              onConfirm={onToggle}
            />
          )}
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={onEdit}
          >
            <Pencil size={13} />
            Edit
          </button>
        </footer>
      </aside>
    </>
  )
}

function EditorError({ error }: { error?: Failure }) {
  return error ? (
    <div className="form-error" role="alert">
      <strong>{error.message}</strong>
      <p>{error.hint}</p>
    </div>
  ) : null
}
function currentError() {
  return useAppStore.getState().error
}
function EditorButtons({
  busy,
  onClose,
  label = 'Save changes',
}: {
  busy: boolean
  onClose: () => void
  label?: string
}) {
  return (
    <footer>
      <span />
      <button
        className="button secondary"
        type="button"
        disabled={busy}
        onClick={onClose}
      >
        Cancel
      </button>
      <button className="button primary" disabled={busy}>
        {busy ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <Check size={14} />
        )}
        {label}
      </button>
    </footer>
  )
}

function CreateSkillEditor({
  projectId,
  scopeName,
  onClose,
}: {
  projectId: string | null
  scopeName?: string
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState<Failure>()
  const busy = useCatalogStore((state) => state.pending > 0)
  async function save(event: FormEvent) {
    event.preventDefault()
    try {
      await catalogAction((api) =>
        api.createSkill({ projectId, name, description, instructions }),
      )
      onClose()
    } catch {
      setError(currentError())
    }
  }
  return (
    <Modal
      title="Create a skill"
      subtitle={
        scopeName
          ? `Project · ${scopeName}`
          : 'Global · available in every project'
      }
      onClose={onClose}
      busy={busy}
      wide
    >
      <form className="workspace-form" onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy}>
          <label htmlFor="skill-name">
            Skill name<span>Folder name</span>
          </label>
          <input
            id="skill-name"
            autoFocus
            required
            maxLength={64}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            placeholder="react-frontend"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="form-helper">Lowercase letters, numbers and hyphens.</p>
          <label htmlFor="skill-description">Description</label>
          <textarea
            id="skill-description"
            required
            maxLength={1024}
            rows={2}
            placeholder="When should this skill be selected?"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <label htmlFor="skill-instructions">Instructions</label>
          <textarea
            id="skill-instructions"
            required
            maxLength={100000}
            rows={9}
            placeholder="Describe the workflow and the resources it should use."
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </fieldset>
        <EditorError error={error} />
        <EditorButtons busy={busy} onClose={onClose} label="Create skill" />
      </form>
    </Modal>
  )
}

function SkillEditor({
  document,
  projectId,
  onClose,
}: {
  document: SkillDocument
  projectId: string | null
  onClose: () => void
}) {
  const [file, setFile] = useState('SKILL.md')
  const [newPath, setNewPath] = useState('references/guide.md')
  const [content, setContent] = useState(document.content)
  const [initial, setInitial] = useState(document.content)
  const [hash, setHash] = useState<string | null>(document.hash)
  const [error, setError] = useState<Failure>()
  const busy = useCatalogStore((state) => state.pending > 0)
  async function changeFile(next: string) {
    if (content !== initial) {
      setError({
        code: 'UNSAVED_RESOURCE',
        message: 'Save or discard this draft before switching files.',
        hint: 'Your draft is still in the editor.',
      })
      return
    }
    setError(undefined)
    if (next === '__new__') {
      setFile(next)
      setContent('')
      setInitial('')
      setHash(null)
      return
    }
    try {
      const result = await catalogAction((api) =>
        api.readSkillFile({ projectId, id: document.skill.id, file: next }),
      )
      setFile(next)
      setContent(result.content)
      setInitial(result.content)
      setHash(result.hash)
    } catch {
      setError(currentError())
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    try {
      await catalogAction((api) =>
        api.saveSkillFile({
          projectId,
          id: document.skill.id,
          expectedRevision: document.skill.revision,
          expectedHash: hash,
          file: file === '__new__' ? newPath : file,
          content,
        }),
      )
      onClose()
    } catch {
      setError(currentError())
    }
  }
  return (
    <Modal
      title={document.skill.name}
      subtitle="Edit skill files"
      onClose={onClose}
      busy={busy}
      wide
    >
      <form className="workspace-form" onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy}>
          <label htmlFor="skill-resource">
            Skill files<span>{document.files.length} resources</span>
          </label>
          <div className="select-wrap">
            <select
              id="skill-resource"
              value={file}
              onChange={(event) => void changeFile(event.target.value)}
            >
              {document.files.map((file) => (
                <option
                  value={file.path}
                  key={file.path}
                  disabled={!file.editable}
                >
                  {file.path}
                  {!file.editable ? ' (binary or large asset)' : ''}
                </option>
              ))}
              <option value="__new__">+ New text resource</option>
            </select>
            <ChevronDown size={13} />
          </div>
          {file === '__new__' && (
            <>
              <label htmlFor="resource-path">Relative resource path</label>
              <input
                id="resource-path"
                required
                value={newPath}
                maxLength={240}
                placeholder="scripts/check.py"
                onChange={(event) => setNewPath(event.target.value)}
              />
            </>
          )}
          <div className="resource-editor-label">
            <label htmlFor="resource-content">
              <FileCode2 size={13} />
              {file === '__new__' ? newPath : file}
            </label>
            {content !== initial && (
              <button
                type="button"
                onClick={() => {
                  setContent(initial)
                  setError(undefined)
                }}
              >
                Discard draft
              </button>
            )}
          </div>
          <textarea
            id="resource-content"
            className="skill-code-editor"
            spellCheck={false}
            rows={16}
            maxLength={250000}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <p
            className="form-helper"
            title="SKILL.md requires name and description in YAML frontmatter. Text resources are editable up to 250 KB; other assets remain in the folder."
          >
            Keep the name and description at the top of SKILL.md.
          </p>
        </fieldset>
        <EditorError error={error} />
        <EditorButtons busy={busy} onClose={onClose} />
      </form>
    </Modal>
  )
}

function ProfileEditor({
  profile,
  snapshot,
  projectId,
  scopeName,
  onClose,
}: {
  profile?: AgentProfile
  snapshot: CatalogSnapshot
  projectId: string | null
  scopeName?: string
  onClose: () => void
}) {
  const [name, setName] = useState(profile?.name ?? '')
  const [roleInstructions, setRole] = useState(profile?.roleInstructions ?? '')
  const [styleGuide, setStyle] = useState(profile?.styleGuide ?? '')
  const [skillIds, setSkillIds] = useState(profile?.skillIds ?? [])
  const [model, setModel] = useState(profile?.model ?? '')
  const [effort, setEffort] = useState<Effort | ''>(profile?.effort ?? '')
  const [section, setSection] = useState<'basics' | 'style' | 'skills' | 'model'>(
    'basics',
  )
  const [error, setError] = useState<Failure>()
  const busy = useCatalogStore((state) => state.pending > 0)
  async function save(event: FormEvent) {
    event.preventDefault()
    const fields = {
      projectId,
      name,
      roleInstructions,
      styleGuide,
      skillIds,
      model: model || null,
      effort: effort || null,
    }
    try {
      if (profile)
        await catalogAction((api) =>
          api.updateProfile({
            ...fields,
            id: profile.id,
            expectedRevision: profile.revision,
          }),
        )
      else await catalogAction((api) => api.createProfile(fields))
      onClose()
    } catch {
      setError(currentError())
    }
  }
  return (
    <Modal
      title={profile ? 'Edit agent profile' : 'Create an agent profile'}
      subtitle={
        scopeName
          ? `Project · ${scopeName}`
          : 'Global · selectable in every project'
      }
      onClose={onClose}
      busy={busy}
      wide
    >
      <form
        className="workspace-form"
        onSubmit={(event) => void save(event)}
        onInvalidCapture={() => setSection('basics')}
      >
        <div className="editor-tabs" role="tablist" aria-label="Profile sections">
          {(
            [
              ['basics', 'Basics'],
              ['style', 'Style guide'],
              ['skills', `Skills · ${skillIds.length}`],
              ['model', 'Model'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              className={section === id ? 'selected' : ''}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <fieldset disabled={busy}>
          <div className="editor-section" hidden={section !== 'basics'}>
          <label htmlFor="profile-name">Profile name</label>
          <input
            id="profile-name"
            autoFocus
            required
            maxLength={100}
            placeholder="Frontend Master"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <label htmlFor="profile-role">Role instructions</label>
          <textarea
            id="profile-role"
            rows={4}
            maxLength={40000}
            value={roleInstructions}
            onChange={(event) => setRole(event.target.value)}
            placeholder="Describe the agent’s expertise, responsibilities, and approach."
          />
          </div>
          <div className="editor-section" hidden={section !== 'style'}>
          <label htmlFor="profile-style">Style guide</label>
          <textarea
            id="profile-style"
            rows={4}
            maxLength={40000}
            value={styleGuide}
            onChange={(event) => setStyle(event.target.value)}
            placeholder="Code conventions, visual style, communication preferences, and examples."
          />
          </div>
          <div className="editor-section" hidden={section !== 'skills'}>
          <label>
            Selected skills<span>{skillIds.length} / 20</span>
          </label>
          <SkillSelector
            skills={snapshot.skills}
            selected={skillIds}
            onChange={setSkillIds}
            disabled={busy}
          />
          </div>
          <div className="editor-section" hidden={section !== 'model'}>
          <ModelFields
            model={model}
            effort={effort}
            onModel={setModel}
            onEffort={setEffort}
            disabled={busy}
          />
          <p className="form-helper">A single run can still override these.</p>
          </div>
        </fieldset>
        <EditorError error={error} />
        <EditorButtons
          busy={busy}
          onClose={onClose}
          label={profile ? 'Save profile' : 'Create profile'}
        />
      </form>
    </Modal>
  )
}
