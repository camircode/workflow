import type {
  Assignment,
  NotificationAttempt,
  TaskForUser,
  TaskWithAssignees,
  User,
  UserWithPendingTasks,
} from '../../domain/model.js'

/**
 * Los objetos del dominio llevan Date; JSON no. Convertir aquí, una sola vez,
 * mantiene a todos los repositorios al margen de la cuestión y a todas las
 * respuestas consistentes — en lugar de que unos endpoints emitan una cadena ISO
 * y otros lo que JSON.stringify hiciera ese día con un Date.
 */

export const presentUser = (user: User) => ({
  id: user.id,
  name: user.name,
  lastName: user.lastName,
  email: user.email,
  createdAt: user.createdAt.toISOString(),
})

export const presentUserWithPendingTasks = (user: UserWithPendingTasks) => ({
  ...presentUser(user),
  pendingTasks: user.pendingTasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
  })),
})

const presentAssignee = (assignee: Assignment) => ({
  userId: assignee.userId,
  name: assignee.name,
  lastName: assignee.lastName,
  email: assignee.email,
  completed: assignee.completed,
  completedAt: assignee.completedAt?.toISOString() ?? null,
})

export const presentTask = (task: TaskWithAssignees) => ({
  id: task.id,
  title: task.title,
  description: task.description,
  status: task.status,
  archivedAt: task.archivedAt?.toISOString() ?? null,
  createdAt: task.createdAt.toISOString(),
  assignees: task.assignees.map(presentAssignee),
})

export const presentTaskForUser = (task: TaskForUser) => ({
  id: task.id,
  title: task.title,
  description: task.description,
  status: task.status,
  archivedAt: task.archivedAt?.toISOString() ?? null,
  createdAt: task.createdAt.toISOString(),
  completed: task.completed,
  completedAt: task.completedAt?.toISOString() ?? null,
})

export const presentNotificationAttempt = (attempt: NotificationAttempt) => ({
  attemptNumber: attempt.attemptNumber,
  attemptedAt: attempt.attemptedAt.toISOString(),
  httpStatus: attempt.httpStatus,
  error: attempt.error,
})
