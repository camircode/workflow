/**
 * What this system is about, in types. No persistence, no HTTP, no framework.
 */

export type TaskStatus = 'open' | 'archived'

export interface User {
  id: number
  name: string
  lastName: string
  email: string
  createdAt: Date
}

/** A person's participation in one task. */
export interface Assignment {
  userId: number
  name: string
  lastName: string
  email: string
  completed: boolean
  completedAt: Date | null
}

export interface Task {
  id: number
  title: string
  description: string | null
  status: TaskStatus
  archivedAt: Date | null
  createdAt: Date
}

export interface TaskWithAssignees extends Task {
  assignees: Assignment[]
}

/** One task as it looks from a particular person's side of it. */
export interface TaskForUser extends Task {
  completed: boolean
  completedAt: Date | null
}

export interface UserWithPendingTasks extends User {
  pendingTasks: Array<Pick<Task, 'id' | 'title' | 'status'>>
}

export interface NotificationAttempt {
  attemptNumber: number
  attemptedAt: Date
  /** Null when the destination never answered: a timeout has no status code. */
  httpStatus: number | null
  error: string | null
}

/**
 * A task is archived exactly when every person assigned to it has finished
 * their part. A task with nobody assigned is not finished — it has not started.
 */
export const everyoneHasFinished = (assignees: readonly Assignment[]): boolean =>
  assignees.length > 0 && assignees.every((a) => a.completed)
