/**
 * De qué trata este sistema, en tipos. Sin persistencia, sin HTTP, sin framework.
 */

export type TaskStatus = 'open' | 'archived'

export interface User {
  id: number
  name: string
  lastName: string
  email: string
  createdAt: Date
}

/** La participación de una persona en una tarea. */
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

/** Una tarea vista desde el lado de una persona concreta. */
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
  /** Null cuando el destino nunca respondió: un timeout no tiene código de estado. */
  httpStatus: number | null
  error: string | null
}

/**
 * Una tarea se archiva exactamente cuando todas las personas asignadas a ella
 * han terminado su parte. Una tarea sin nadie asignado no está terminada: no ha
 * empezado.
 */
export const everyoneHasFinished = (assignees: readonly Assignment[]): boolean =>
  assignees.length > 0 && assignees.every((a) => a.completed)
