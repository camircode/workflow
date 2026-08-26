import type {
  ArchivedTaskNotification,
  Notifier,
  NotificationOutcome,
} from '#application/ports.js'

/**
 * Un único POST al destino configurado, con un timeout.
 *
 * Nunca lanza. Que una notificación falle es un resultado esperado del que se
 * deja constancia, no una excepción para que alguien más arriba la interprete —
 * y el llamante necesita el código de estado, o la ausencia de uno, en cualquier
 * caso.
 */
export class HttpNotifier implements Notifier {
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  async send(payload: ArchivedTaskNotification): Promise<NotificationOutcome> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.timeoutMs)

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abort.signal,
      })
      return {
        httpStatus: response.status,
        error: response.ok ? null : `El destino respondió ${response.status}.`,
      }
    } catch (error) {
      // Ninguna respuesta en absoluto: un timeout, una conexión rechazada, DNS.
      // No hay código de estado que registrar, y por eso la columna admite null.
      return { httpStatus: null, error: describe(error, abort.signal.aborted, this.timeoutMs) }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * El fetch de Node reporta todo fallo de transporte como "fetch failed" y pone
 * lo que realmente ocurrió en `cause`. Registrar solo el envoltorio significaría
 * una columna llena de cadenas idénticas que nunca dice si fue DNS, una conexión
 * rechazada o un reset — que es la única pregunta que el registro existe para
 * responder.
 */
function describe(error: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `Sin respuesta en ${timeoutMs}ms.`
  if (!(error instanceof Error)) return String(error)

  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code
    return code ? `${error.message}: ${cause.message} (${String(code)})` : `${error.message}: ${cause.message}`
  }
  return error.message
}
