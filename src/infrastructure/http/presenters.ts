import type {
  Assignment,
  NotificationAttempt,
  TaskForUser,
  TaskWithAssignees,
  User,
  UserWithPendingTasks,
} from '../../domain/model.js'

/**
 * Domain objects carry Date; JSON does not. Converting here, once, keeps every
 * repository free of the question and every response consistent — rather than
 * some endpoints emitting an ISO string and others whatever JSON.stringify
 * happened to do with a Date that day.
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
