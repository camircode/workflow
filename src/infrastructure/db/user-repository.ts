import type { PoolClient } from 'pg'
import { emailAlreadyRegistered } from '#domain/errors.js'
import type { TaskForUser, User, UserWithPendingTasks } from '#domain/model.js'
import type { NewUser, UserRepository } from '#application/ports.js'
import { isUniqueViolation } from './errors.js'

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly client: PoolClient) {}

  async create(user: NewUser): Promise<User> {
    try {
      const { rows } = await this.client.query(
        `INSERT INTO users (name, last_name, email)
         VALUES ($1, $2, $3)
         RETURNING id, name, last_name, email, created_at`,
        [user.name, user.lastName, user.email],
      )
      return toUser(rows[0])
    } catch (error) {
      // Preguntar primero e insertar después sería una condición de carrera: dos
      // registros de la misma dirección pueden encontrarla libre ambos. El índice
      // es lo único que puede decidir, así que decide, y esto traduce su
      // respuesta.
      if (isUniqueViolation(error, 'users_email_lower_key')) {
        throw emailAlreadyRegistered(user.email)
      }
      throw error
    }
  }

  async findById(id: number): Promise<User | null> {
    const { rows } = await this.client.query(
      'SELECT id, name, last_name, email, created_at FROM users WHERE id = $1',
      [id],
    )
    return rows[0] ? toUser(rows[0]) : null
  }

  async findMissingIds(ids: readonly number[]): Promise<number[]> {
    if (ids.length === 0) return []
    // Todos los id que faltan de una vez, para que un llamante que corrige cuatro
    // erratas no tenga que enviar cuatro peticiones para encontrar la siguiente.
    const { rows } = await this.client.query(
      `SELECT candidate AS id
         FROM unnest($1::bigint[]) AS candidate
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = candidate)
        ORDER BY candidate`,
      [ids],
    )
    return rows.map((row: { id: number }) => row.id)
  }

  async listWithPendingTasks(): Promise<UserWithPendingTasks[]> {
    const { rows } = await this.client.query(
      `SELECT u.id, u.name, u.last_name, u.email, u.created_at,
              COALESCE(
                json_agg(
                  json_build_object('id', t.id, 'title', t.title, 'status', t.status)
                  ORDER BY t.id
                ) FILTER (WHERE t.id IS NOT NULL),
                '[]'
              ) AS pending_tasks
         FROM users u
         LEFT JOIN task_assignments ta
                ON ta.user_id = u.id AND ta.completed_at IS NULL
         LEFT JOIN tasks t ON t.id = ta.task_id
        GROUP BY u.id
        ORDER BY u.id`,
    )
    return rows.map((row: UserRow & { pending_tasks: UserWithPendingTasks['pendingTasks'] }) => ({
      ...toUser(row),
      pendingTasks: row.pending_tasks,
    }))
  }

  async listTasksFor(userId: number): Promise<TaskForUser[]> {
    const { rows } = await this.client.query(
      `SELECT t.id, t.title, t.description, t.status, t.archived_at, t.created_at,
              ta.completed_at
         FROM task_assignments ta
         JOIN tasks t ON t.id = ta.task_id
        WHERE ta.user_id = $1
        ORDER BY t.id`,
      [userId],
    )
    return rows.map((row: TaskForUserRow) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      completed: row.completed_at !== null,
      completedAt: row.completed_at,
    }))
  }
}

interface UserRow {
  id: number
  name: string
  last_name: string
  email: string
  created_at: Date
}

interface TaskForUserRow {
  id: number
  title: string
  description: string | null
  status: 'open' | 'archived'
  archived_at: Date | null
  created_at: Date
  completed_at: Date | null
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  name: row.name,
  lastName: row.last_name,
  email: row.email,
  createdAt: row.created_at,
})
