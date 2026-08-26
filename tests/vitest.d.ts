// Declares what global setup hands to the test files, so inject('databaseUrl')
// is typed rather than a string nobody checks.
//
// In its own file, and importing 'vitest', because a module augmentation only
// applies when the module being augmented is part of the program — and the setup
// file itself imports from 'vitest/node', which is a different module.
import 'vitest'

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string
  }
}
