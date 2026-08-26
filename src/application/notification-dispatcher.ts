import type { ArchivedTask, Database, Notifier } from './ports.js'

export interface DispatcherOptions {
  maxAttempts: number
  /** Attempt n waits backoffMs * 2^(n-1) before it runs. */
  backoffMs: number
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Delivers the archived-task notification, retrying with increasing waits, and
 * writing down every attempt whether it worked or not.
 *
 * Each attempt is recorded in its own transaction rather than all of them at the
 * end. A process that dies during the second attempt still leaves evidence of
 * the first, which is the difference between a record and a summary.
 *
 * Runs after the archiving transaction has committed, never inside it: holding a
 * database transaction open across a network call to somebody else's server ties
 * the lifetime of a row lock to how slow a stranger is.
 */
export class NotificationDispatcher {
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly db: Database,
    private readonly notifier: Notifier,
    private readonly options: DispatcherOptions,
  ) {}

  /**
   * Starts delivery without waiting for it. The caller has already committed;
   * making them wait out two backoffs to learn something they cannot act on
   * would only make the request slower.
   */
  dispatch(task: ArchivedTask): void {
    const run = this.deliver(task).catch(() => {
      // deliver() records its own failures. Nothing here can do better than
      // that, and an unhandled rejection would take the process down.
    })
    this.inFlight.add(run)
    void run.finally(() => this.inFlight.delete(run))
  }

  /** Waits for every delivery started so far. For tests and for shutdown. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight])
    }
  }

  /**
   * Delivers now and waits. `dispatch` is this, without the waiting — the
   * reconciler needs to know when it is finished, a request does not.
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

      // A 4xx is the destination saying the request itself is wrong. Sending the
      // identical body twice more cannot change that answer, so only a 5xx or no
      // answer at all is worth another attempt — which is what the contract asks
      // for and also what is true.
      const worthRetrying = outcome.httpStatus === null || outcome.httpStatus >= 500
      if (!worthRetrying) {
        return
      }
    }
  }
}
