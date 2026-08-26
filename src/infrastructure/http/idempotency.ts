import { createHash } from 'node:crypto'
import type { Database, UnitOfWork } from '../../application/ports.js'

export const IDEMPOTENCY_HEADER = 'idempotency-key'

export interface Executed<T> {
  body: T
  /**
   * Se ejecuta una vez, después de que la transacción haga commit, y solo para el
   * llamante que realmente realizó la operación. Una reproducción nunca lo
   * dispara.
   *
   * Aquí es donde va la notificación. Enviarla dentro de la transacción ataría un
   * lock de fila a lo que tarde en responder el servidor de otro; enviarla antes
   * del commit significaría anunciar algo que todavía podría revertirse.
   */
  afterCommit?: () => void
}

export interface HttpResult<T, S extends number> {
  status: S
  body: T
}

/**
 * JSON canónico, para que dos peticiones que solo difieren en el orden de las
 * claves den el mismo hash.
 *
 * El cuerpo que se hashea aquí es el que Zod ya ha parseado, así que además está
 * normalizado — un título enviado con espacios alrededor y el mismo título sin
 * ellos son una única petición, que es lo que quiere decir un llamante que
 * reintenta tras un doble clic con "la misma petición".
 */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`)
  return `{${entries.join(',')}}`
}

const hashOf = (body: unknown): string =>
  createHash('sha256').update(canonicalise(body)).digest('hex')

/**
 * Ejecuta una escritura una sola vez por Idempotency-Key, incluso cuando la
 * misma clave llega dos veces en el mismo momento.
 *
 * Sin clave la operación simplemente se ejecuta — la cabecera se ofrece, no se
 * exige, porque exigirla rompería a todos los llamantes que no tienen ningún
 * problema de reintentos.
 */
export async function runIdempotent<T, S extends number>(
  db: Database,
  key: string | undefined,
  endpoint: string,
  body: unknown,
  status: S,
  operation: (uow: UnitOfWork) => Promise<Executed<T>>,
): Promise<HttpResult<T, S>> {
  if (key === undefined || key === '') {
    const executed = await db.transaction(operation)
    executed.afterCommit?.()
    return { status, body: executed.body }
  }

  const requestHash = hashOf(body)

  const outcome = await db.transaction(async (uow) => {
    const claim = await uow.idempotency.claim(key, endpoint, requestHash)
    if (!claim.owned) return { replay: claim.replay } as const

    const executed = await operation(uow)
    // Se guarda dentro de la misma transacción que el trabajo en sí: si el
    // trabajo se revierte no hay respuesta que reproducir, y la clave vuelve a
    // estar libre.
    await uow.idempotency.complete(key, endpoint, { status, body: executed.body })
    return { executed } as const
  })

  if ('replay' in outcome && outcome.replay) {
    // La respuesta almacenada es la que escribió este mismo manejador, con este
    // mismo estado, y JSONB la devuelve intacta. El cast afirma exactamente eso y
    // nada más amplio — es el único sitio donde el sistema de tipos no puede
    // seguir el valor a través de la base de datos y de vuelta.
    return {
      status: outcome.replay.status as S,
      body: outcome.replay.body as T,
    }
  }
  if ('executed' in outcome) {
    outcome.executed.afterCommit?.()
    return { status, body: outcome.executed.body }
  }
  // claim() solo devuelve owned:false con una reproducción, o lanza.
  throw new Error('La operación idempotente no produjo ni un resultado ni una reproducción.')
}
