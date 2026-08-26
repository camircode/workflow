import { z } from 'zod'

/**
 * Configuration is read once, validated, and then it is a value. A missing or
 * malformed variable stops the process at startup with a message naming it,
 * rather than surfacing as an undefined halfway through the first request that
 * happens to need it.
 */
const Schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /**
   * Where the archived-task notification is POSTed. Required, and deliberately
   * not defaulted: a default would make a misconfigured deployment look like a
   * working one until somebody went looking for notifications that were never
   * sent anywhere.
   */
  NOTIFY_URL: z.url('NOTIFY_URL must be a URL'),

  PORT: z.coerce.number().int().positive().optional(),
  HOST: z.string().default('0.0.0.0'),

  /**
   * The homelab's application scaffold sets LISTEN_ADDR=":8080" for every
   * workload, a Go convention this project inherits rather than argues with.
   * PORT wins when both are set, because that is what a Node process is expected
   * to honour and what .env.example documents.
   */
  LISTEN_ADDR: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** How long to wait for the notification destination before calling it a failure. */
  NOTIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /**
   * Base for the backoff between notification attempts: attempt n waits
   * base * 2^(n-1). Configurable so the tests do not spend real seconds
   * proving that waiting happens.
   */
  NOTIFY_BACKOFF_MS: z.coerce.number().int().nonnegative().default(1_000),
})

export type Config = Omit<z.infer<typeof Schema>, 'PORT' | 'LISTEN_ADDR'> & { PORT: number }

const DEFAULT_PORT = 8080

/** ":8080" and "0.0.0.0:8080" both mean 8080. */
function portFromListenAddr(value: string | undefined): number | undefined {
  if (!value) return undefined
  const port = Number.parseInt(value.slice(value.lastIndexOf(':') + 1), 10)
  return Number.isInteger(port) && port > 0 ? port : undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid configuration:\n${problems}`)
  }
  const { PORT, LISTEN_ADDR, ...rest } = parsed.data
  return { ...rest, PORT: PORT ?? portFromListenAddr(LISTEN_ADDR) ?? DEFAULT_PORT }
}

/** The most attempts the notification is given, per the reliability contract. */
export const MAX_NOTIFICATION_ATTEMPTS = 3
