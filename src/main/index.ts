import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type IpcMainInvokeEvent,
} from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  newSessionSchema,
  runInputSchema,
  type Result,
} from '../shared/contracts'
import { catalogContextSchema } from '../shared/catalog'
import { channels } from '../shared/ipc'
import { applicationFailure } from './application/errors'
import { WorkspaceService } from './application/workspace-service'
import { CatalogService } from './application/catalog-service'
import { GraphService } from './application/graph-service'
import { openWorkspaceDatabase, type WorkspaceDatabase } from './db/database'
import { ConnectivityService } from './codex/service'
import { SessionStore } from './codex/storage'

const directory = dirname(fileURLToPath(import.meta.url))
let window: BrowserWindow | null = null
let service: ConnectivityService | undefined
let database: WorkspaceDatabase | undefined
let closing = false

function handle<T>(
  channel: string,
  action: (payload: unknown) => T | Promise<T>,
): void {
  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<Result<T>> => {
      try {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== event.sender.mainFrame
        ) {
          throw new Error(
            'IPC rejected: this frame does not own the application session.',
          )
        }
        return { ok: true, value: await action(payload) }
      } catch (error) {
        return { ok: false, error: applicationFailure(error) }
      }
    },
  )
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    title: 'AgentConstella',
    backgroundColor: '#101114',
    show: false,
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => {
    window = null
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('preload-error', (_event, path, error) => {
    console.error(`[AgentConstella] Failed to load preload ${path}:`, error)
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(directory, '../renderer/index.html'))
}

app.setName('AgentConstella')
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  void app
    .whenReady()
    .then(async () => {
      database = openWorkspaceDatabase(
        join(app.getPath('userData'), 'workspace.sqlite'),
      )
      const workspace = new WorkspaceService(database)
      const catalog = new CatalogService(
        database,
        app.getPath('userData'),
        () => service?.snapshot().diagnostics?.models ?? [],
      )
      const graphs = new GraphService(
        database,
        catalog,
        () => service?.snapshot().diagnostics?.models ?? [],
      )
      handle(channels.graphGet, (input) => graphs.get(input))
      handle(channels.graphSave, (input) => graphs.save(input))
      handle(channels.graphPrepare, (input) => graphs.prepareStart(input))
      graphs.subscribe((identity) => {
        if (window && !window.isDestroyed())
          window.webContents.send(channels.graphChanged, identity)
      })
      handle(channels.catalogSnapshot, (context) =>
        catalog.getSnapshot(context),
      )
      handle(channels.createSkill, (input) => catalog.createSkill(input))
      handle(channels.getSkill, (input) => catalog.getSkill(input))
      handle(channels.readSkillFile, (input) => catalog.readSkillFile(input))
      handle(channels.saveSkillFile, (input) => catalog.saveSkillFile(input))
      handle(channels.setSkillActive, (input) => catalog.setSkillActive(input))
      handle(channels.createProfile, (input) => catalog.createProfile(input))
      handle(channels.updateProfile, (input) => catalog.updateProfile(input))
      handle(channels.setProfileActive, (input) =>
        catalog.setProfileActive(input),
      )
      handle(channels.importSkill, async (input) => {
        const context = catalogContextSchema.parse(input)
        catalog.getSnapshot(context)
        const selection = await dialog.showOpenDialog(window!, {
          title: 'Import a skill folder',
          message:
            'Select a folder containing SKILL.md and its optional resources.',
          buttonLabel: 'Import skill',
          properties: ['openDirectory'],
        })
        if (selection.canceled || !selection.filePaths[0]) return null
        return catalog.importSkill({ ...context, path: selection.filePaths[0] })
      })
      catalog.subscribe(() => {
        if (window && !window.isDestroyed())
          window.webContents.send(channels.catalogChanged)
      })
      handle(channels.workspaceSnapshot, () => workspace.getSnapshot())
      handle(channels.chooseRepository, async () => {
        const selection = await dialog.showOpenDialog(window!, {
          title: 'Open a project folder',
          message:
            'Choose a project folder. Git will be initialized if the folder is not already a repository.',
          buttonLabel: 'Open folder',
          properties: ['openDirectory', 'createDirectory'],
        })
        if (selection.canceled || !selection.filePaths[0]) return null
        return workspace.openFolder({ path: selection.filePaths[0] })
      })
      handle(channels.chooseNewProject, async () => {
        const selection = await dialog.showSaveDialog(window!, {
          title: 'Create a project folder',
          message:
            'Choose a name and location for the new project folder. Git will be initialized on the main branch.',
          nameFieldLabel: 'Project folder name:',
          defaultPath: join(app.getPath('documents'), 'untitled-project'),
          buttonLabel: 'Create project',
          properties: ['createDirectory'],
        })
        if (selection.canceled || !selection.filePath) return null
        return workspace.createProject({ path: selection.filePath })
      })
      handle(channels.updateProject, (input) => workspace.updateProject(input))
      handle(channels.createTask, (input) => workspace.createTask(input))
      handle(channels.updateTask, (input) => workspace.updateTask(input))
      handle(channels.moveTask, (input) => workspace.moveTask(input))
      handle(channels.archiveTask, (input) => workspace.archiveTask(input))
      handle(channels.restoreTask, (input) => workspace.restoreTask(input))
      workspace.subscribe((snapshot) => {
        if (window && !window.isDestroyed())
          window.webContents.send(channels.workspaceChanged, snapshot)
      })
      service = new ConnectivityService(
        new SessionStore(join(app.getPath('userData'), 'connectivity')),
        undefined,
        (input, workspace, runId, projectId) =>
          catalog.resolveRun(input, workspace, runId, projectId),
      )
      await service.initialize()
      handle(channels.state, () => service!.snapshot())
      handle(channels.diagnostics, () => service!.refreshDiagnostics())
      handle(channels.run, (input) =>
        service!.start(runInputSchema.parse(input)),
      )
      handle(channels.stop, () => service!.stop())
      handle(channels.reset, (input) => {
        const context = newSessionSchema.parse(input ?? {})
        catalog.getSnapshot({ projectId: context.projectId ?? null })
        return service!.newSession(context.projectId)
      })
      service.subscribe((state) => {
        if (window && !window.isDestroyed())
          window.webContents.send(channels.updated, state)
      })
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === 'darwin'
            ? [{ role: 'appMenu' as const }]
            : []),
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
      )
      createWindow()
      app.on('activate', () => {
        if (!window) createWindow()
      })
    })
    .catch((error) => {
      const failure = applicationFailure(error)
      dialog.showErrorBox(
        'AgentConstella could not start',
        `${failure.message}\n\n${failure.hint}`,
      )
      app.quit()
    })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', () => database?.close())
  app.on('before-quit', (event) => {
    if (closing || !service) return
    event.preventDefault()
    closing = true
    const deadline = new Promise<void>((resolve) => {
      setTimeout(resolve, 4_000).unref()
    })
    void Promise.race([service.shutdown(), deadline])
      .catch(() => {})
      .finally(() => app.quit())
  })
}
