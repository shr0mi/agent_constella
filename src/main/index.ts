import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
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
import { applicationFailure, ApplicationError } from './application/errors'
import { WorkspaceService } from './application/workspace-service'
import { CatalogService } from './application/catalog-service'
import { GraphService } from './application/graph-service'
import { NodeExecutionService } from './application/node-execution-service'
import { WorkflowService } from './application/workflow-service'
import { ManagerTools } from './application/manager-tools'
import { ManagerService } from './application/manager-service'
import { LocalMcpServer } from './mcp/server'
import { NativeCliClient } from './terminal/client'
import { TerminalHost, configureTerminalHost } from './terminal/host'
import {
  terminalIdSchema,
  terminalReadSchema,
  terminalInputSchema,
  terminalResizeSchema,
  terminalFinishSchema,
} from '../shared/terminal'
import { graphIdentitySchema } from '../shared/graph'
import { openWorkspaceDatabase, type WorkspaceDatabase } from './db/database'
import { ConnectivityService } from './codex/service'
import { SessionStore } from './codex/storage'

const directory = dirname(fileURLToPath(import.meta.url))
let window: BrowserWindow | null = null
let service: ConnectivityService | undefined
let execution: NodeExecutionService | undefined
let workflow: WorkflowService | undefined
let managers: ManagerService | undefined
let mcp: LocalMcpServer | undefined
let database: WorkspaceDatabase | undefined
let closing = false
let terminals: TerminalHost

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
    backgroundColor: '#f3f5f8',
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
      terminals = new TerminalHost(
        join(app.getPath('userData'), 'terminals'),
        join(directory, 'terminal-daemon.js'),
      )
      configureTerminalHost(terminals)
      await terminals.initialize()
      handle(channels.terminalList, () => terminals.list())
      handle(channels.terminalRead, (input) =>
        terminals.read(terminalReadSchema.parse(input)),
      )
      handle(channels.terminalInput, (input) =>
        terminals.input(terminalInputSchema.parse(input)),
      )
      handle(channels.terminalResize, (input) =>
        terminals.resize(terminalResizeSchema.parse(input)),
      )
      handle(channels.terminalFinish, (input) =>
        terminals.finish(terminalFinishSchema.parse(input)),
      )
      handle(channels.terminalClose, (input) =>
        terminals.close(terminalIdSchema.parse(input).sessionId),
      )
      database = openWorkspaceDatabase(
        join(app.getPath('userData'), 'workspace.sqlite'),
      )
      const workspace = new WorkspaceService(
        database,
        () => service?.snapshot().diagnostics?.models ?? [],
      )
      const catalog = new CatalogService(
        database,
        app.getPath('userData'),
        () => service?.snapshot().diagnostics?.models ?? [],
      )
      await catalog.initialize()
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
      execution = new NodeExecutionService(
        database,
        graphs,
        catalog,
        app.getPath('userData'),
      )
      await execution.initialize()
      workflow = new WorkflowService(
        database,
        graphs,
        catalog,
        execution,
        workspace,
      )
      await workflow.initialize()
      const managerTools = new ManagerTools(
        database,
        workspace,
        graphs,
        catalog,
        workflow,
        () => service?.snapshot().diagnostics?.models ?? [],
      )
      mcp = new LocalMcpServer(managerTools)
      await mcp.start()
      managers = new ManagerService(database, managerTools, mcp)
      managers.initialize()
      await managers.reconnect()
      workspace.setProjectDeletionGuard((projectId) => {
        if (workflow!.hasActiveProject(projectId))
          return 'A worker run, workflow transition, or integration is active in this project.'
        if (managers!.hasActiveProject(projectId))
          return 'A manager conversation is active in this project.'
        if (service?.hasActiveProject(projectId))
          return 'The connectivity lab is using this project.'
        if (catalog.hasPendingOperations())
          return 'Catalog changes are still in progress.'
        return undefined
      })
      execution.setMcpConnection((identity) => {
        const connection = mcp!.issue(
          { projectId: identity.projectId, taskId: identity.taskId },
          'worker',
          async (summary) => {
            const id = execution!.get(identity).threadId
            if (!id?.startsWith('terminal:'))
              throw new Error(
                'This worker terminal is not ready to hand back a result.',
              )
            await terminals.finish({ sessionId: id.slice(9), summary })
          },
        )
        return {
          client: new NativeCliClient(connection.options),
          release: connection.release,
        }
      })
      execution.reconnect()
      handle(channels.managerGet, (input) => managers!.get(input))
      handle(channels.managerList, (input) => managers!.list(input))
      handle(channels.managerNewChat, (input) => managers!.newChat(input))
      handle(channels.managerSelectChat, (input) => managers!.selectChat(input))
      handle(channels.managerSend, (input) => managers!.send(input))
      handle(channels.managerStop, (input) => managers!.stop(input))
      handle(channels.managerHistory, (input) => managerTools.history(input))
      handle(channels.managerUndo, async (input) => {
        await managerTools.undo(input)
        // Refresh history after its Undo marker is committed.
        workspace.notify()
      })
      managers.subscribe((scope) => {
        if (window && !window.isDestroyed())
          window.webContents.send(channels.managerChanged, scope)
      })
      handle(channels.workflowGet, (input) => workflow!.get(input))
      handle(channels.workflowStart, (input) => workflow!.start(input))
      handle(channels.workflowPause, (input) => workflow!.pause(input))
      handle(channels.workflowAccept, (input) =>
        workflow!.accept(input, 'desktop-human'),
      )
      handle(channels.workflowReview, (input) =>
        workflow!.review(input, 'desktop-human'),
      )
      handle(channels.workflowPreview, (input) =>
        workflow!.previewIntegration(input),
      )
      handle(channels.workflowIntegrate, (input) =>
        workflow!.integrate(input, 'desktop-human'),
      )
      workflow.subscribe((identity) => {
        if (window && !window.isDestroyed())
          window.webContents.send(channels.workflowChanged, identity)
      })
      handle(channels.taskExecution, (input) => ({
        ...execution!.getTask(input),
        workflow: workflow!.get(input),
      }))
      handle(channels.nodeSessions, () => execution!.listSessions())
      handle(channels.taskReview, (input) => execution!.getReview(input))
      handle(channels.taskOpenIde, (input) => execution!.openInIde(input))
      handle(channels.taskCheckout, (input) => workflow!.checkoutTask(input))
      handle(channels.taskOpenWorktree, async (input) => {
        const context = await execution!.getReview(input)
        const error = await shell.openPath(context.path)
        if (error)
          throw new ApplicationError(
            'OPEN_TASK_FOLDER',
            error,
            'Copy the task folder path and open it in your IDE or file manager.',
          )
      })
      handle(channels.nodeGet, (input) => {
        const snapshot = execution!.get(input)
        return {
          ...snapshot,
          workflow: workflow!.get(
            graphIdentitySchema.parse({
              projectId: snapshot.projectId,
              taskId: snapshot.taskId,
            }),
          ),
        }
      })
      handle(channels.nodeStart, (input) => workflow!.startNode(input))
      handle(channels.nodeStop, (input) => execution!.stop(input))
      handle(channels.nodeRun, (input) => execution!.getRun(input))
      handle(channels.nodeDiff, (input) => execution!.getDiff(input))
      execution.subscribe((identity) => {
        if (window && !window.isDestroyed())
          window.webContents.send(channels.nodeChanged, identity)
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
      handle(channels.projectOpenIde, (input) => workspace.openInIde(input))
      handle(channels.chooseRepository, async () => {
        const selection = await dialog.showOpenDialog(window!, {
          title: 'Open a project folder',
          message:
            'Choose a project folder. The app initializes Git if needed and adds an empty initial commit when the project has no commits. Existing files are preserved.',
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
            'Choose a name and location for the new project folder. The app initializes Git on main with an empty initial commit so task branches share a common starting point.',
          nameFieldLabel: 'Project folder name:',
          defaultPath: join(app.getPath('documents'), 'untitled-project'),
          buttonLabel: 'Create project',
          properties: ['createDirectory'],
        })
        if (selection.canceled || !selection.filePath) return null
        return workspace.createProject({ path: selection.filePath })
      })
      handle(channels.updateProject, (input) => workspace.updateProject(input))
      handle(channels.deleteProject, async (input) => {
        let deletedId: string | undefined
        const deleted = await workspace.deleteProject(
          input,
          async (project) => {
            const choice = await dialog.showMessageBox(window!, {
              type: 'warning',
              title: 'Delete project',
              message: `Delete “${project.name}”?`,
              detail: `This permanently removes this project's settings, tasks, graphs, saved conversations, run records, history, and local catalog entries from AgentConstella. This cannot be undone.\n\nRepository: ${project.repoPath}\n\nRepository files, skill folders, Git branches, and task worktree folders are kept on disk.`,
              buttons: ['Cancel', 'Delete project'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
            if (choice.response !== 1) return false
            deletedId = project.id
            return true
          },
          'desktop-human',
        )
        if (
          deleted &&
          service &&
          service.snapshot().session.projectId === deletedId
        ) {
          // The scratch lab's archived conversations are independent of project
          // records. Clear its selection so future lab turns remain usable.
          try {
            await service.newSession()
          } catch (error) {
            console.error(
              'Could not clear the deleted project from the scratch lab:',
              error,
            )
          }
        }
        return deleted
      })
      handle(channels.createTask, (input) => workspace.createTask(input))
      handle(channels.updateTask, (input) => workspace.updateTask(input))
      handle(channels.moveTask, (input) => workspace.moveTask(input))
      handle(channels.archiveTask, (input) =>
        managerTools.archiveDesktop(input),
      )
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
    void Promise.race([
      Promise.all([
        service.shutdown(true),
        managers?.shutdown(true),
        workflow?.shutdown(true) ?? execution?.shutdown(true),
      ]),
      deadline,
    ])
      .catch(() => {})
      .finally(() => {
        void mcp?.shutdown().finally(() => app.quit())
      })
  })
}
