import { create } from 'zustand'
import type { Result } from '../../shared/contracts'
import type { WorkspaceBridge, WorkspaceSnapshot } from '../../shared/workspace'
import { unwrap, useAppStore } from './store'

interface WorkspaceStore {
  snapshot?: WorkspaceSnapshot
  loading: boolean
  pending: number
  setSnapshot: (snapshot: WorkspaceSnapshot) => void
  setLoading: (loading: boolean) => void
}
export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  loading: true,
  pending: 0,
  setSnapshot: (snapshot) =>
    set((current) =>
      current.snapshot && current.snapshot.revision > snapshot.revision
        ? {}
        : { snapshot, loading: false },
    ),
  setLoading: (loading) => set({ loading }),
}))

export async function workspaceAction<T>(
  action: (api: WorkspaceBridge) => Promise<Result<T>>,
): Promise<T> {
  useWorkspaceStore.setState((state) => ({ pending: state.pending + 1 }))
  useAppStore.getState().setError(undefined)
  try {
    const bridge = window.constella?.workspace
    if (!bridge)
      throw new Error(
        'The project bridge is unavailable. Fully restart the desktop app with npm run dev.',
      )
    return await unwrap(action(bridge))
  } catch (error) {
    if (!useAppStore.getState().error)
      useAppStore.getState().setError({
        code: 'WORKSPACE',
        message: error instanceof Error ? error.message : String(error),
        hint: 'Refresh the workspace and try again. Your saved data is retained.',
      })
    throw error
  } finally {
    useWorkspaceStore.setState((state) => ({ pending: state.pending - 1 }))
  }
}

export async function refreshWorkspace(): Promise<void> {
  useWorkspaceStore.getState().setLoading(true)
  try {
    useWorkspaceStore
      .getState()
      .setSnapshot(await workspaceAction((api) => api.getSnapshot()))
  } catch {
    useWorkspaceStore.getState().setLoading(false)
  }
}
