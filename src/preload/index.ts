import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, ConstellaBridge, RunInput } from '../shared/contracts'
import { channels } from '../shared/ipc'
import type { WorkspaceSnapshot } from '../shared/workspace'

// Expose named operations only. The renderer cannot access ipcRenderer, credentials, or Node.
const bridge: ConstellaBridge = {
  catalog: {
    getSnapshot: (context) =>
      ipcRenderer.invoke(channels.catalogSnapshot, context),
    createSkill: (input) => ipcRenderer.invoke(channels.createSkill, input),
    importSkill: (context) => ipcRenderer.invoke(channels.importSkill, context),
    getSkill: (input) => ipcRenderer.invoke(channels.getSkill, input),
    readSkillFile: (input) => ipcRenderer.invoke(channels.readSkillFile, input),
    saveSkillFile: (input) => ipcRenderer.invoke(channels.saveSkillFile, input),
    setSkillActive: (input) =>
      ipcRenderer.invoke(channels.setSkillActive, input),
    createProfile: (input) => ipcRenderer.invoke(channels.createProfile, input),
    updateProfile: (input) => ipcRenderer.invoke(channels.updateProfile, input),
    setProfileActive: (input) =>
      ipcRenderer.invoke(channels.setProfileActive, input),
    onChange(callback) {
      const listener = (): void => callback()
      ipcRenderer.on(channels.catalogChanged, listener)
      return () => ipcRenderer.removeListener(channels.catalogChanged, listener)
    },
  },
  workspace: {
    getSnapshot: () => ipcRenderer.invoke(channels.workspaceSnapshot),
    chooseRepository: () => ipcRenderer.invoke(channels.chooseRepository),
    chooseNewProject: () => ipcRenderer.invoke(channels.chooseNewProject),
    updateProject: (input) => ipcRenderer.invoke(channels.updateProject, input),
    createTask: (input) => ipcRenderer.invoke(channels.createTask, input),
    updateTask: (input) => ipcRenderer.invoke(channels.updateTask, input),
    moveTask: (input) => ipcRenderer.invoke(channels.moveTask, input),
    archiveTask: (input) => ipcRenderer.invoke(channels.archiveTask, input),
    restoreTask: (input) => ipcRenderer.invoke(channels.restoreTask, input),
    onChange(callback) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        snapshot: WorkspaceSnapshot,
      ): void => callback(snapshot)
      ipcRenderer.on(channels.workspaceChanged, listener)
      return () =>
        ipcRenderer.removeListener(channels.workspaceChanged, listener)
    },
  },
  getState: () => ipcRenderer.invoke(channels.state),
  diagnose: () => ipcRenderer.invoke(channels.diagnostics),
  run: (input: RunInput) => ipcRenderer.invoke(channels.run, input),
  stop: () => ipcRenderer.invoke(channels.stop),
  newSession: (context) => ipcRenderer.invoke(channels.reset, context),
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
