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
import { runInputSchema, type Result } from '../shared/contracts'
import { channels } from '../shared/ipc'
import { describeError } from './codex/errors'
import { ConnectivityService } from './codex/service'
import { SessionStore } from './codex/storage'

const directory = dirname(fileURLToPath(import.meta.url))
let window: BrowserWindow | null = null
let service: ConnectivityService | undefined
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
        return { ok: false, error: describeError(error) }
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
      service = new ConnectivityService(
        new SessionStore(join(app.getPath('userData'), 'connectivity')),
      )
      await service.initialize()
      handle(channels.state, () => service!.snapshot())
      handle(channels.diagnostics, () => service!.refreshDiagnostics())
      handle(channels.run, (input) =>
        service!.start(runInputSchema.parse(input)),
      )
      handle(channels.stop, () => service!.stop())
      handle(channels.reset, () => service!.newSession())
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
      const failure = describeError(error)
      dialog.showErrorBox(
        'AgentConstella could not start',
        `${failure.message}\n\n${failure.hint}`,
      )
      app.quit()
    })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
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
