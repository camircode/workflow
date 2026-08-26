import type { PoolClient } from 'pg'
import type {
  Assignment,
  NotificationAttempt,
  Task,
  TaskStatus,
  TaskWithAssignees,
} from '../../domain/model.js'
import type { ArchivedTask, NewTask, TaskRepository } from '../../application/ports.js'

/** Se reconstruye en tres consultas, así que vive en un único sitio. */
const ASSIGNEES_JSON = `
  COALESCE(
    json_agg(
      json_build_object(
        'userId',      u.id,
        'name',        u.name,
        'lastName',    u.last_name,
        'email',       u.email,
        'completed',   ta.completed_at IS NOT NULL,
        'completedAt', ta.completed_at
      ) ORDER BY u.id
    ) FILTER (WHERE u.id IS NOT NULL),
    '[]'
  ) AS assignees`

const TASK_COLUMNS = 't.id, t.title, t.description, t.status, t.archived_at, t.created_at'

export class PostgresTaskRepository implements TaskRepository {
  constructor(private readonly client: PoolClient) {}

  async create(task: NewTask): Promise<Task> {
    const { rows } = await this.client.query(
      `INSERT INTO tasks (title, description)
       VALUES ($1, $2)
       RETURNING id, title, description, status, archived_at, created_at`,
      [task.title, task.description],
    )
    return toTask(rows[0])
  }

  async findById(id: number): Promise<Task | null> {
    const { rows } = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = $1`,
      [id],
    )
    return rows[0] ? toTask(rows[0]) : null
  }

  async findByIdForUpdate(id: number): Promise<Task | null> {
    // Todo lo que decide contra el estado de esta tarea se encola aquí. Es la
    // razón por la que dos personas terminando las dos últimas partes en el mismo
    // instante producen un archivado y una notificación en vez de ninguno o dos.
    const { rows } = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = $1 FOR UPDATE`,
      [id],
    )
    return rows[0] ? toTask(rows[0]) : null
  }

  async list(status?: TaskStatus): Promise<TaskWithAssignees[]> {
    // Una consulta con un agregado en lugar de una consulta por tarea: el listado
    // es el endpoint con más probabilidades de llamarse con muchas filas detrás.
    const { rows } = await this.client.query(
      `SELECT ${TASK_COLUMNS}, ${ASSIGNEES_JSON}
         FROM tasks t
         LEFT JOIN task_assignments ta ON ta.task_id = t.id
         LEFT JOIN users u ON u.id = ta.user_id
        WHERE $1::task_status IS NULL OR t.status = $1::task_status
        GROUP BY t.id
        ORDER BY t.id`,
      [status ?? null],
    )
    return rows.map(toTaskWithAssignees)
  }

  async findWithAssignees(id: number): Promise<TaskWithAssignees | null> {
    const { rows } = await this.client.query(
      `SELECT ${TASK_COLUMNS}, ${ASSIGNEES_JSON}
         FROM tasks t
         LEFT JOIN task_assignments ta ON ta.task_id = t.id
         LEFT JOIN users u ON u.id = ta.user_id
        WHERE t.id = $1
        GROUP BY t.id`,
      [id],
    )
    return rows[0] ? toTaskWithAssignees(rows[0]) : null
  }

  async assign(taskId: number, userIds: readonly number[]): Promise<void> {
    if (userIds.length === 0) return
    // La clave primaria sobre (task_id, user_id) es lo que hace inofensiva una
    // repetición, así que esto puede insertar sin preguntar qué hay ya.
    await this.client.query(
      `INSERT INTO task_assignments (task_id, user_id)
       SELECT $1, candidate FROM unnest($2::bigint[]) AS candidate
       ON CONFLICT (task_id, user_id) DO NOTHING`,
      [taskId, userIds],
    )
  }

  async findAssignment(taskId: number, userId: number): Promise<Assignment | null> {
    const { rows } = await this.client.query(
      `SELECT u.id AS "userId", u.name, u.last_name AS "lastName", u.email,
              ta.completed_at
         FROM task_assignments ta
         JOIN users u ON u.id = ta.user_id
        WHERE ta.task_id = $1 AND ta.user_id = $2`,
      [taskId, userId],
    )
    const row = rows[0]
    if (!row) return null
    return {
      userId: row.userId,
      name: row.name,
      lastName: row.lastName,
      email: row.email,
      completed: row.completed_at !== null,
      completedAt: row.completed_at,
    }
  }

  async markPartCompleted(taskId: number, userId: number): Promise<void> {
    await this.client.query(
      `UPDATE task_assignments SET completed_at = now()
        WHERE task_id = $1 AND user_id = $2 AND completed_at IS NULL`,
      [taskId, userId],
    )
  }

  async archiveIfEveryonePartFinished(taskId: number): Promise<ArchivedTask | null> {
    // La decisión entera es esta sentencia, y quien la toma es la base de datos.
    // Pase lo que pase alrededor, esta fila se le puede entregar a exactamente un
    // llamante, y tenerla es la licencia para notificar.
    //
    // El segundo EXISTS importa: una tarea a la que no hay nadie asignado no tiene
    // partes pendientes, lo cual no es lo mismo que estar terminada. Sin él, crear
    // una tarea y tocarla archivaría algo que nunca empezó.
    const { rows } = await this.client.query(
      `UPDATE tasks
          SET status = 'archived', archived_at = now()
        WHERE id = $1
          AND status = 'open'
          AND EXISTS (SELECT 1 FROM task_assignments WHERE task_id = $1)
          AND NOT EXISTS (
            SELECT 1 FROM task_assignments
             WHERE task_id = $1 AND completed_at IS NULL)
      RETURNING id, title, archived_at`,
      [taskId],
    )
    const row = rows[0]
    return row ? { id: row.id, title: row.title, archivedAt: row.archived_at } : null
  }

  async findArchivedWithoutNotification(): Promise<ArchivedTask[]> {
    const { rows } = await this.client.query(
      `SELECT t.id, t.title, t.archived_at
         FROM tasks t
        WHERE t.status = 'archived'
          AND NOT EXISTS (
            SELECT 1 FROM notification_attempts n WHERE n.task_id = t.id)
        ORDER BY t.id`,
    )
    return rows.map((row: { id: number; title: string; archived_at: Date }) => ({
      id: row.id,
      title: row.title,
      archivedAt: row.archived_at,
    }))
  }

  async recordNotificationAttempt(
    taskId: number,
    attempt: NotificationAttempt,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO notification_attempts
         (task_id, attempt_number, attempted_at, http_status, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [taskId, attempt.attemptNumber, attempt.attemptedAt, attempt.httpStatus, attempt.error],
    )
  }

  async listNotificationAttempts(taskId: number): Promise<NotificationAttempt[]> {
    const { rows } = await this.client.query(
      `SELECT attempt_number, attempted_at, http_status, error
         FROM notification_attempts
        WHERE task_id = $1
        ORDER BY attempt_number`,
      [taskId],
    )
    return rows.map((row: AttemptRow) => ({
      attemptNumber: row.attempt_number,
      attemptedAt: row.attempted_at,
      httpStatus: row.http_status,
      error: row.error,
    }))
  }
}

interface TaskRow {
  id: number
  title: string
  description: string | null
  status: TaskStatus
  archived_at: Date | null
  created_at: Date
}

interface AttemptRow {
  attempt_number: number
  attempted_at: Date
  http_status: number | null
  error: string | null
}

/** Tal como lo deja json_build_object: los timestamps son cadenas ISO, no Date. */
interface AssigneeJson {
  userId: number
  name: string
  lastName: string
  email: string
  completed: boolean
  completedAt: string | null
}

const toTask = (row: TaskRow): Task => ({
  id: row.id,
  title: row.title,
  description: row.description,
  status: row.status,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
})

const toTaskWithAssignees = (
  row: TaskRow & { assignees: AssigneeJson[] },
): TaskWithAssignees => ({
  ...toTask(row),
  assignees: row.assignees.map((a) => ({
    userId: a.userId,
    name: a.name,
    lastName: a.lastName,
    email: a.email,
    completed: a.completed,
    completedAt: a.completedAt === null ? null : new Date(a.completedAt),
  })),
})
