import type { ConstellaBridge } from '../../shared/contracts'
declare global {
  interface Window {
    constella?: ConstellaBridge
  }
}
export {}
