import {
  taskAlreadyArchived,
  taskNotFound,
  userNotAssigned,
  userNotFound,
} from '../domain/errors.js'
import type {
  NotificationAttempt,
  Task,
  TaskStatus,
  TaskWithAssignees,
} from '../domain/model.js'
import type { ArchivedTask, NewTask, UnitOfWork } from './ports.js'

export const createTask = (uow: UnitOfWork, input: NewTask): Promise<Task> =>
  uow.tasks.create(input)

export const listTasks = (
  uow: UnitOfWork,
  status?: TaskStatus,
): Promise<TaskWithAssignees[]> => uow.tasks.list(status)

export async function getTask(uow: UnitOfWork, taskId: number): Promise<TaskWithAssignees> {
  const task = await uow.tasks.findWithAssignees(taskId)
  if (!task) throw taskNotFound(taskId)
  return task
}

export async function assignUsers(
  uow: UnitOfWork,
  taskId: number,
  userIds: readonly number[],
): Promise<void> {
  // Se bloquea por el mismo motivo por el que la bloquea una compleción: esto
  // decide contra el estado actual de la tarea, y ese estado no debe cambiar por
  // debajo de la decisión.
  const task = await uow.tasks.findByIdForUpdate(taskId)
  if (!task) throw taskNotFound(taskId)
  if (task.status === 'archived') throw taskAlreadyArchived(taskId)

  // El mismo id dos veces en una misma petición es una sola asignación. La clave
  // primaria rechazaría el duplicado de todas formas; decirlo aquí hace que la
  // intención sea legible en lugar de quedar delegada a una violación de
  // restricción que nadie ve.
  const unique = [...new Set(userIds)]

  const missing = await uow.users.findMissingIds(unique)
  if (missing.length > 0) throw userNotFound(missing)

  await uow.tasks.assign(taskId, unique)
}

export interface CompletionResult {
  /** Solo tiene valor para el único llamante cuya compleción archivó la tarea. */
  archived: ArchivedTask | null
}

/**
 * Marca como terminada la parte de una persona en una tarea, y archiva la tarea
 * si esa era la última parte pendiente.
 *
 * El lock tomado sobre la tarea es lo que hace cierto el "archivada exactamente
 * una vez". Dos personas terminando las dos últimas partes en el mismo instante
 * leerían, de otro modo, el trabajo sin commit de la otra como todavía
 * pendiente, y nadie archivaría nada. Serializadas, la segunda ve la compleción
 * de la primera y archiva; el UPDATE condicional garantiza entonces que solo una
 * de ellas puede llegar a hacerlo.
 */
export async function completePart(
  uow: UnitOfWork,
  taskId: number,
  userId: number,
): Promise<CompletionResult> {
  const task = await uow.tasks.findByIdForUpdate(taskId)
  if (!task) throw taskNotFound(taskId)

  const user = await uow.users.findById(userId)
  if (!user) throw userNotFound(userId)

  const assignment = await uow.tasks.findAssignment(taskId, userId)
  if (!assignment) throw userNotAssigned(userId, taskId)

  // Ya está hecho — por una petición anterior, o por aquella de la que esta es
  // un duplicado. Volver a decirlo no es un error, y no debe archivar ni
  // notificar dos veces.
  if (assignment.completed) return { archived: null }

  await uow.tasks.markPartCompleted(taskId, userId)

  return { archived: await uow.tasks.archiveIfEveryonePartFinished(taskId) }
}

export async function listNotificationAttempts(
  uow: UnitOfWork,
  taskId: number,
): Promise<NotificationAttempt[]> {
  const task = await uow.tasks.findById(taskId)
  if (!task) throw taskNotFound(taskId)
  return uow.tasks.listNotificationAttempts(taskId)
}
