import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, ConstellaBridge, RunInput } from '../shared/contracts'
import { channels } from '../shared/ipc'

// Expose named operations only. The renderer cannot access ipcRenderer, credentials, or Node.
const bridge: ConstellaBridge = {
  getState: () => ipcRenderer.invoke(channels.state),
  diagnose: () => ipcRenderer.invoke(channels.diagnostics),
  run: (input: RunInput) => ipcRenderer.invoke(channels.run, input),
  stop: () => ipcRenderer.invoke(channels.stop),
  newSession: () => ipcRenderer.invoke(channels.reset),
  onState(callback) {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: AppState,
    ): void => callback(state)
    ipcRenderer.on(channels.updated, listener)
    return () => ipcRenderer.removeListener(channels.updated, listener)
  },
}
contextBridge.exposeInMainWorld('constella', bridge)
