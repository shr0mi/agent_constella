import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, ConstellaBridge, RunInput } from '../shared/contracts'
import { channels } from '../shared/ipc'
import type { WorkspaceSnapshot } from '../shared/workspace'
import type { GraphIdentity } from '../shared/graph'
import type { ManagerScope } from '../shared/manager'

// Expose named operations only. The renderer cannot access ipcRenderer, credentials, or Node.
const bridge: ConstellaBridge = {
  manager: {
    get: (input) => ipcRenderer.invoke(channels.managerGet, input),
    list: (input) => ipcRenderer.invoke(channels.managerList, input),
    newChat: (input) => ipcRenderer.invoke(channels.managerNewChat, input),
    selectChat: (input) =>
      ipcRenderer.invoke(channels.managerSelectChat, input),
    send: (input) => ipcRenderer.invoke(channels.managerSend, input),
    stop: (input) => ipcRenderer.invoke(channels.managerStop, input),
    history: (input) => ipcRenderer.invoke(channels.managerHistory, input),
    undo: (input) => ipcRenderer.invoke(channels.managerUndo, input),
    onChange(callback) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        scope: ManagerScope,
      ): void => callback(scope)
      ipcRenderer.on(channels.managerChanged, listener)
      return () => ipcRenderer.removeListener(channels.managerChanged, listener)
    },
  },
  workflow: {
    get: (input) => ipcRenderer.invoke(channels.workflowGet, input),
    start: (input) => ipcRenderer.invoke(channels.workflowStart, input),
    pause: (input) => ipcRenderer.invoke(channels.workflowPause, input),
    accept: (input) => ipcRenderer.invoke(channels.workflowAccept, input),
    review: (input) => ipcRenderer.invoke(channels.workflowReview, input),
    previewIntegration: (input) =>
      ipcRenderer.invoke(channels.workflowPreview, input),
    integrate: (input) => ipcRenderer.invoke(channels.workflowIntegrate, input),
    onChange(callback) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        identity: GraphIdentity,
      ): void => callback(identity)
      ipcRenderer.on(channels.workflowChanged, listener)
      return () =>
        ipcRenderer.removeListener(channels.workflowChanged, listener)
    },
  },
  execution: {
    getTask: (input) => ipcRenderer.invoke(channels.taskExecution, input),
    getReview: (input) => ipcRenderer.invoke(channels.taskReview, input),
    openWorktree: (input) =>
      ipcRenderer.invoke(channels.taskOpenWorktree, input),
    get: (input) => ipcRenderer.invoke(channels.nodeGet, input),
    start: (input) => ipcRenderer.invoke(channels.nodeStart, input),
    stop: (input) => ipcRenderer.invoke(channels.nodeStop, input),
    getRun: (input) => ipcRenderer.invoke(channels.nodeRun, input),
    getDiff: (input) => ipcRenderer.invoke(channels.nodeDiff, input),
    onChange(callback) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        identity: GraphIdentity,
      ): void => callback(identity)
      ipcRenderer.on(channels.nodeChanged, listener)
      return () => ipcRenderer.removeListener(channels.nodeChanged, listener)
    },
  },
  graphs: {
    get: (input) => ipcRenderer.invoke(channels.graphGet, input),
    save: (input) => ipcRenderer.invoke(channels.graphSave, input),
    prepareStart: (input) => ipcRenderer.invoke(channels.graphPrepare, input),
    onChange(callback) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        identity: GraphIdentity,
      ): void => callback(identity)
      ipcRenderer.on(channels.graphChanged, listener)
      return () => ipcRenderer.removeListener(channels.graphChanged, listener)
    },
  },
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
    deleteProject: (input) => ipcRenderer.invoke(channels.deleteProject, input),
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
