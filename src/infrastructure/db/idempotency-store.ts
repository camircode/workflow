import type { PoolClient } from 'pg'
import { DomainError, idempotencyKeyReused } from '../../domain/errors.js'
import type { IdempotencyClaim, IdempotencyStore, StoredResponse } from '../../application/ports.js'

/**
 * Hace que un POST se pueda enviar dos veces sin peligro.
 *
 * La parte difícil no es que la segunda petición llegue más tarde — es que la
 * segunda petición llegue *al mismo tiempo*, que es exactamente lo que producen
 * un doble clic y un reintento automático.
 *
 * Se podrían intentar tres cosas y solo la tercera funciona:
 *
 *   INSERT ... ON CONFLICT DO NOTHING por sí solo no le dice nada al perdedor.
 *   No devuelve ninguna fila, y la fila del ganador todavía no tiene commit, así
 *   que un SELECT posterior tampoco la ve. El perdedor se entera de que no ganó
 *   y no puede averiguar qué ocurrió.
 *
 *   Añadir SELECT ... FOR UPDATE no lo rescata, por el mismo motivo: bajo READ
 *   COMMITTED una fila sin commit no es visible, así que no hay nada que
 *   bloquear.
 *
 *   Un advisory lock con alcance de transacción sobre la clave sí lo consigue. El
 *   segundo llamante se bloquea hasta que la transacción del primero termina, y
 *   solo entonces mira. Si el primero hizo commit, su respuesta está ahí para
 *   reproducirse. Si hizo rollback, su fila ya no está y el segundo llamante pasa
 *   a ser el dueño. No hay ninguna ventana intermedia y nada gira en vacío.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly client: PoolClient) {}

  async claim(key: string, endpoint: string, requestHash: string): Promise<IdempotencyClaim> {
    // Se retiene hasta que esta transacción termina, de modo que una clave se
    // procesa de una en una.
    //
    // Dos claves distintas pueden dar el mismo hash y quedarían entonces
    // encoladas una detrás de otra. Eso cuesta un poco de concurrencia y ninguna
    // corrección, que es el lado correcto de ese compromiso.
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${endpoint}:${key}`,
    ])

    const claimed = await this.client.query(
      `INSERT INTO idempotency_keys (key, endpoint, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (key, endpoint) DO NOTHING
       RETURNING key`,
      [key, endpoint, requestHash],
    )
    if (claimed.rowCount === 1) return { owned: true }

    const { rows } = await this.client.query(
      `SELECT request_hash, state, response_status, response_body
         FROM idempotency_keys
        WHERE key = $1 AND endpoint = $2`,
      [key, endpoint],
    )
    const row = rows[0]

    // El advisory lock lo retenía quien la insertó, y su transacción ha
    // terminado: o la fila tiene commit o nunca existió. Que aquí falte la fila
    // significaría que el lock no hizo su trabajo.
    if (!row) {
      throw new DomainError(
        'INTERNAL_ERROR',
        'La clave de idempotencia no se reclamó ni se encontró. Esto debería ser imposible.',
      )
    }

    // Una clave nombra una petición. Responder a un cuerpo distinto con la
    // respuesta del primer cuerpo sería peor que rechazarla: el llamante creería
    // que ocurrió algo que nunca ocurrió.
    if (row.request_hash !== requestHash) throw idempotencyKeyReused(key)

    if (row.state !== 'completed') {
      throw new DomainError(
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        `Una petición anterior con la Idempotency-Key ${key} todavía se está procesando.`,
      )
    }

    return {
      owned: false,
      replay: { status: row.response_status, body: row.response_body },
    }
  }

  async complete(key: string, endpoint: string, response: StoredResponse): Promise<void> {
    await this.client.query(
      `UPDATE idempotency_keys
          SET state = 'completed', response_status = $3, response_body = $4
        WHERE key = $1 AND endpoint = $2`,
      [key, endpoint, response.status, JSON.stringify(response.body)],
    )
  }
}
