import { z } from 'zod'

/**
 * La configuración se lee una vez, se valida y a partir de ahí es un valor. Una
 * variable ausente o malformada detiene el proceso en el arranque con un mensaje
 * que la nombra, en lugar de aparecer como un undefined a mitad de la primera
 * petición que resulte necesitarla.
 */
const Schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),

  /**
   * Adonde se envía por POST la notificación de tarea archivada. Es obligatoria
   * y deliberadamente no tiene valor por defecto: un valor por defecto haría que
   * un despliegue mal configurado pareciera uno que funciona hasta que alguien
   * fuera a buscar notificaciones que nunca se enviaron a ninguna parte.
   */
  NOTIFY_URL: z.url('NOTIFY_URL debe ser una URL'),

  PORT: z.coerce.number().int().positive().optional(),
  HOST: z.string().default('0.0.0.0'),

  /**
   * El andamiaje de aplicaciones del homelab define LISTEN_ADDR=":8080" para
   * toda carga de trabajo, una convención de Go que este proyecto hereda en vez
   * de discutir. PORT gana cuando ambas están definidas, porque es lo que se
   * espera que respete un proceso de Node y lo que documenta .env.example.
   */
  LISTEN_ADDR: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Cuánto esperar al destino de la notificación antes de darlo por fallido. */
  NOTIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /**
   * Base del backoff entre intentos de notificación: el intento n espera
   * base * 2^(n-1). Es configurable para que las pruebas no gasten segundos
   * reales demostrando que la espera ocurre.
   */
  NOTIFY_BACKOFF_MS: z.coerce.number().int().nonnegative().default(1_000),
})

export type Config = Omit<z.infer<typeof Schema>, 'PORT' | 'LISTEN_ADDR'> & { PORT: number }

const DEFAULT_PORT = 8080

/** ":8080" y "0.0.0.0:8080" significan ambos 8080. */
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
    throw new Error(`Configuración inválida:\n${problems}`)
  }
  const { PORT, LISTEN_ADDR, ...rest } = parsed.data
  return { ...rest, PORT: PORT ?? portFromListenAddr(LISTEN_ADDR) ?? DEFAULT_PORT }
}

/** El máximo de intentos que se le concede a la notificación, según el contrato de fiabilidad. */
export const MAX_NOTIFICATION_ATTEMPTS = 3
