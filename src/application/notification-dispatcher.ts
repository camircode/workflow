import type { ArchivedTask, Database, Notifier } from './ports.js'

export interface DispatcherOptions {
  maxAttempts: number
  /** El intento n espera backoffMs * 2^(n-1) antes de ejecutarse. */
  backoffMs: number
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Entrega la notificación de tarea archivada, reintentando con esperas
 * crecientes y dejando constancia de cada intento, funcionara o no.
 *
 * Cada intento se registra en su propia transacción, y no todos ellos al final.
 * Un proceso que muere durante el segundo intento sigue dejando evidencia del
 * primero, que es la diferencia entre un registro y un resumen.
 *
 * Se ejecuta después de que la transacción del archivado haya hecho commit,
 * nunca dentro de ella: mantener abierta una transacción de base de datos
 * durante una llamada de red al servidor de otro ata la duración de un lock de
 * fila a lo lento que sea un extraño.
 */
export class NotificationDispatcher {
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly db: Database,
    private readonly notifier: Notifier,
    private readonly options: DispatcherOptions,
  ) {}

  /**
   * Inicia la entrega sin esperar a que termine. El llamante ya ha hecho commit;
   * hacerle esperar dos backoffs para enterarse de algo sobre lo que no puede
   * actuar solo haría la petición más lenta.
   */
  dispatch(task: ArchivedTask): void {
    const run = this.deliver(task).catch(() => {
      // deliver() registra sus propios fallos. Nada de lo que se haga aquí puede
      // mejorar eso, y un rechazo no gestionado tumbaría el proceso.
    })
    this.inFlight.add(run)
    void run.finally(() => this.inFlight.delete(run))
  }

  /** Espera a todas las entregas iniciadas hasta el momento. Para las pruebas y para el apagado. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight])
    }
  }

  /**
   * Entrega ahora y espera. `dispatch` es esto mismo, sin la espera — el
   * reconciliador necesita saber cuándo ha terminado, una petición no.
   */
  async deliver(task: ArchivedTask): Promise<void> {
    const payload = {
      taskId: task.id,
      title: task.title,
      archivedAt: task.archivedAt.toISOString(),
    }

    for (let attemptNumber = 1; attemptNumber <= this.options.maxAttempts; attemptNumber++) {
      if (attemptNumber > 1) {
        await sleep(this.options.backoffMs * 2 ** (attemptNumber - 2))
      }

      const outcome = await this.notifier.send(payload)

      await this.db.transaction(async (uow) => {
        await uow.tasks.recordNotificationAttempt(task.id, {
          attemptNumber,
          attemptedAt: new Date(),
          httpStatus: outcome.httpStatus,
          error: outcome.error,
        })
      })

      if (outcome.httpStatus !== null && outcome.httpStatus >= 200 && outcome.httpStatus < 300) {
        return
      }

      // Un 4xx es el destino diciendo que la petición en sí está mal. Enviar el
      // mismo cuerpo idéntico dos veces más no puede cambiar esa respuesta, así
      // que solo un 5xx o la ausencia total de respuesta merecen otro intento —
      // que es lo que pide el contrato y también lo que es cierto.
      const worthRetrying = outcome.httpStatus === null || outcome.httpStatus >= 500
      if (!worthRetrying) {
        return
      }
    }
  }
}
