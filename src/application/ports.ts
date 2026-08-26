/**
 * What the use cases need from the outside world, stated as interfaces they own.
 *
 * The adapters in src/infrastructure implement these. Nothing here imports pg,
 * fastify or node:http — which is what makes the use cases testable without any
 * of them, and what makes replacing PostgreSQL a question about one directory.
 */

import type {
  Assignment,
  NotificationAttempt,
  Task,
  TaskForUser,
  TaskStatus,
  TaskWithAssignees,
  User,
  UserWithPendingTasks,
} from '../domain/model.js'

/**
 * A unit of work. Every use case that changes more than one row runs inside one
 * of these, so a failure halfway through leaves nothing behind.
 */
export interface UnitOfWork {
  users: UserRepository
  tasks: TaskRepository
  idempotency: IdempotencyStore
}

export interface Database {
  /** Runs `fn` in a transaction, committing on return and rolling back on throw. */
  transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>

  /**
   * Runs `fn` only if this process wins `name`, and returns null if it did not.
   *
   * Session-scoped rather than transaction-scoped, because the work it guards
   * spans several transactions and a network call. Two replicas starting
   * together must not both decide to do it.
   */
  withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T | null>

  close(): Promise<void>
}

export interface NewUser {
  name: string
  lastName: string
  email: string
}

export interface UserRepository {
  create(user: NewUser): Promise<User>
  findById(id: number): Promise<User | null>
  /** Returns the ids that do not exist, so a caller can name all of them at once. */
  findMissingIds(ids: readonly number[]): Promise<number[]>
  listWithPendingTasks(): Promise<UserWithPendingTasks[]>
  listTasksFor(userId: number): Promise<TaskForUser[]>
}

export interface NewTask {
  title: string
  description: string | null
}

/** The task as it was at the moment it became archived. */
export interface ArchivedTask {
  id: number
  title: string
  archivedAt: Date
}

export interface TaskRepository {
  create(task: NewTask): Promise<Task>

  /**
   * Reads the task and holds it until the transaction ends.
   *
   * Completions on one task are serialised through this lock. Without it two
   * people finishing the last two parts at the same moment can each look at the
   * other's uncommitted work, each conclude somebody is still pending, and the
   * task is never archived at all.
   */
  findByIdForUpdate(id: number): Promise<Task | null>

  findById(id: number): Promise<Task | null>
  list(status?: TaskStatus): Promise<TaskWithAssignees[]>
  findWithAssignees(id: number): Promise<TaskWithAssignees | null>

  /** Inserts the pairs that are not there yet. Existing ones are left alone. */
  assign(taskId: number, userIds: readonly number[]): Promise<void>

  findAssignment(taskId: number, userId: number): Promise<Assignment | null>
  markPartCompleted(taskId: number, userId: number): Promise<void>

  /**
   * Archives the task if, and only if, it is still open and nobody assigned to
   * it is outstanding. Returns the archived task to exactly one caller and null
   * to every other — which is what makes the notification fire exactly once.
   */
  archiveIfEveryonePartFinished(taskId: number): Promise<ArchivedTask | null>

  /**
   * Tasks that were archived and for which no delivery was ever attempted.
   *
   * That combination can only mean the process died between committing the
   * archive and starting the notification — the one window in which the
   * obligation to notify existed nowhere but in memory.
   */
  findArchivedWithoutNotification(): Promise<ArchivedTask[]>

  recordNotificationAttempt(
    taskId: number,
    attempt: NotificationAttempt,
  ): Promise<void>
  listNotificationAttempts(taskId: number): Promise<NotificationAttempt[]>
}

/** A response already produced for an Idempotency-Key, ready to be replayed. */
export interface StoredResponse {
  status: number
  body: unknown
}

export interface IdempotencyClaim {
  /** True when this caller is the one that gets to perform the operation. */
  owned: boolean
  /** Set when `owned` is false and the original caller has already finished. */
  replay?: StoredResponse
}

export interface IdempotencyStore {
  /**
   * Claims (key, endpoint) for this caller, or blocks until whoever holds it is
   * done and returns their answer.
   */
  claim(key: string, endpoint: string, requestHash: string): Promise<IdempotencyClaim>
  complete(key: string, endpoint: string, response: StoredResponse): Promise<void>
}

export interface NotificationOutcome {
  httpStatus: number | null
  error: string | null
}

/** One POST to the configured destination. Retries are not its concern. */
export interface Notifier {
  send(payload: ArchivedTaskNotification): Promise<NotificationOutcome>
}

export interface ArchivedTaskNotification {
  taskId: number
  title: string
  archivedAt: string
}
