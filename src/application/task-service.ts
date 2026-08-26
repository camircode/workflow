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
  // Locked for the same reason a completion locks it: this decides against the
  // task's current state, and that state must not change underneath the decision.
  const task = await uow.tasks.findByIdForUpdate(taskId)
  if (!task) throw taskNotFound(taskId)
  if (task.status === 'archived') throw taskAlreadyArchived(taskId)

  // The same id twice in one request is one assignment. The primary key would
  // refuse the duplicate anyway; saying so here means the intent is readable
  // rather than delegated to a constraint violation nobody sees.
  const unique = [...new Set(userIds)]

  const missing = await uow.users.findMissingIds(unique)
  if (missing.length > 0) throw userNotFound(missing)

  await uow.tasks.assign(taskId, unique)
}

export interface CompletionResult {
  /** Set only for the one caller whose completion archived the task. */
  archived: ArchivedTask | null
}

/**
 * Marks one person's part of a task as finished, and archives the task if that
 * was the last part outstanding.
 *
 * The lock taken on the task is what makes "archived exactly once" true. Two
 * people finishing the last two parts at the same instant would otherwise each
 * read the other's uncommitted work as still outstanding, and nobody would
 * archive anything. Serialised, the second one sees the first's completion and
 * archives; the conditional update then guarantees only one of them ever can.
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

  // Already done — by an earlier request, or by the one this is a duplicate of.
  // Saying so again is not an error, and it must not archive or notify twice.
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
