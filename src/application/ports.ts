/**
 * Lo que los casos de uso necesitan del mundo exterior, expresado como
 * interfaces de las que ellos son dueños.
 *
 * Los adaptadores de src/infrastructure las implementan. Nada de aquí importa
 * pg, fastify ni node:http — que es lo que hace que los casos de uso se puedan
 * probar sin ninguno de ellos, y lo que convierte reemplazar PostgreSQL en una
 * pregunta sobre un único directorio.
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
} from '#domain/model.js'

/**
 * Una unidad de trabajo. Todo caso de uso que modifique más de una fila se
 * ejecuta dentro de una de estas, de modo que un fallo a mitad de camino no deje
 * nada atrás.
 */
export interface UnitOfWork {
  users: UserRepository
  tasks: TaskRepository
  idempotency: IdempotencyStore
}

export interface Database {
  /** Ejecuta `fn` en una transacción, con commit al retornar y rollback al lanzar. */
  transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>

  /**
   * Ejecuta `fn` solo si este proceso gana `name`, y devuelve null si no lo hizo.
   *
   * Con alcance de sesión y no de transacción, porque el trabajo que protege
   * abarca varias transacciones y una llamada de red. Dos réplicas que arrancan
   * a la vez no deben decidir ambas hacerlo.
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
  /** Devuelve los id que no existen, para que un llamante pueda nombrarlos todos de una vez. */
  findMissingIds(ids: readonly number[]): Promise<number[]>
  listWithPendingTasks(): Promise<UserWithPendingTasks[]>
  listTasksFor(userId: number): Promise<TaskForUser[]>
}

export interface NewTask {
  title: string
  description: string | null
}

/** La tarea tal como estaba en el momento en que quedó archivada. */
export interface ArchivedTask {
  id: number
  title: string
  archivedAt: Date
}

export interface TaskRepository {
  create(task: NewTask): Promise<Task>

  /**
   * Lee la tarea y la retiene hasta que termine la transacción.
   *
   * Las compleciones sobre una misma tarea se serializan a través de este lock.
   * Sin él, dos personas que terminan las dos últimas partes en el mismo momento
   * pueden mirar cada una el trabajo sin commit de la otra, concluir cada una que
   * todavía queda alguien pendiente, y la tarea no archivarse nunca.
   */
  findByIdForUpdate(id: number): Promise<Task | null>

  findById(id: number): Promise<Task | null>
  list(status?: TaskStatus): Promise<TaskWithAssignees[]>
  findWithAssignees(id: number): Promise<TaskWithAssignees | null>

  /** Inserta los pares que todavía no están. Los existentes se dejan como están. */
  assign(taskId: number, userIds: readonly number[]): Promise<void>

  findAssignment(taskId: number, userId: number): Promise<Assignment | null>
  markPartCompleted(taskId: number, userId: number): Promise<void>

  /**
   * Archiva la tarea si, y solo si, sigue abierta y nadie asignado a ella queda
   * pendiente. Devuelve la tarea archivada a exactamente un llamante y null a
   * todos los demás — que es lo que hace que la notificación se dispare
   * exactamente una vez.
   */
  archiveIfEveryonePartFinished(taskId: number): Promise<ArchivedTask | null>

  /**
   * Tareas que fueron archivadas y para las que nunca se intentó una entrega.
   *
   * Esa combinación solo puede significar que el proceso murió entre el commit
   * del archivado y el inicio de la notificación — la única ventana en la que la
   * obligación de notificar no existía en ninguna parte salvo en memoria.
   */
  findArchivedWithoutNotification(): Promise<ArchivedTask[]>

  recordNotificationAttempt(
    taskId: number,
    attempt: NotificationAttempt,
  ): Promise<void>
  listNotificationAttempts(taskId: number): Promise<NotificationAttempt[]>
}

/** Una respuesta ya producida para una Idempotency-Key, lista para reproducirse. */
export interface StoredResponse {
  status: number
  body: unknown
}

export interface IdempotencyClaim {
  /** True cuando este llamante es el que puede realizar la operación. */
  owned: boolean
  /** Tiene valor cuando `owned` es false y el llamante original ya terminó. */
  replay?: StoredResponse
}

export interface IdempotencyStore {
  /**
   * Reclama (key, endpoint) para este llamante, o bloquea hasta que quien lo
   * tenga haya terminado y devuelve su respuesta.
   */
  claim(key: string, endpoint: string, requestHash: string): Promise<IdempotencyClaim>
  complete(key: string, endpoint: string, response: StoredResponse): Promise<void>
}

export interface NotificationOutcome {
  httpStatus: number | null
  error: string | null
}

/** Un único POST al destino configurado. Los reintentos no son asunto suyo. */
export interface Notifier {
  send(payload: ArchivedTaskNotification): Promise<NotificationOutcome>
}

export interface ArchivedTaskNotification {
  taskId: number
  title: string
  archivedAt: string
}
