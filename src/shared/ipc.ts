// Keep the preload's runtime imports free of validation and server dependencies.
export const channels = {
  state: 'constella:state',
  diagnostics: 'constella:diagnostics',
  run: 'constella:run',
  stop: 'constella:stop',
  reset: 'constella:reset',
  updated: 'constella:updated',
} as const
