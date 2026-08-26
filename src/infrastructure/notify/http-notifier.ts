import type {
  ArchivedTaskNotification,
  Notifier,
  NotificationOutcome,
} from '../../application/ports.js'

/**
 * One POST to the configured destination, with a timeout.
 *
 * It never throws. A notification failing is an expected outcome that gets
 * written down, not an exception for somebody upstream to interpret — and the
 * caller needs the status code, or the absence of one, either way.
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
        error: response.ok ? null : `The destination answered ${response.status}.`,
      }
    } catch (error) {
      // No answer at all: a timeout, a refused connection, DNS. There is no
      // status code to record, which is why the column is nullable.
      return { httpStatus: null, error: describe(error, abort.signal.aborted, this.timeoutMs) }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Node's fetch reports every transport failure as "fetch failed" and puts what
 * actually happened in `cause`. Recording only the wrapper would mean a column
 * full of identical strings that never says whether it was DNS, a refused
 * connection or a reset — which is the one question the record exists to answer.
 */
function describe(error: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `No answer within ${timeoutMs}ms.`
  if (!(error instanceof Error)) return String(error)

  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code
    return code ? `${error.message}: ${cause.message} (${String(code)})` : `${error.message}: ${cause.message}`
  }
  return error.message
}
