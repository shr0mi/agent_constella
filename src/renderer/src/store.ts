import { create } from 'zustand'
import type { AppState, Failure, Result } from '../../shared/contracts'

interface Store {
  state?: AppState
  error?: Failure
  checking: boolean
  setState: (state: AppState) => void
  setError: (error?: Failure) => void
  setChecking: (checking: boolean) => void
}
export const useAppStore = create<Store>((set) => ({
  checking: false,
  setState: (state) => set({ state }),
  setError: (error) => set({ error }),
  setChecking: (checking) => set({ checking }),
}))

export async function unwrap<T>(request: Promise<Result<T>>): Promise<T> {
  const result = await request
  if (!result.ok) {
    useAppStore.getState().setError(result.error)
    throw new Error(result.error.message)
  }
  return result.value
}

export async function refreshDiagnostics(): Promise<void> {
  const store = useAppStore.getState()
  if (store.checking || !window.constella) return
  store.setChecking(true)
  try {
    await unwrap(window.constella.diagnose())
  } catch (error) {
    if (!useAppStore.getState().error)
      store.setError({
        code: 'BRIDGE',
        message: String(error),
        hint: 'Restart the desktop app and refresh diagnostics.',
      })
  } finally {
    store.setChecking(false)
  }
}
