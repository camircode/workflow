-- Aplicado por `pnpm db:migrate`, que envuelve esto en una transacción y registra
-- la versión. También se puede ejecutar suelto: psql -1 -f db/migrations/001_initial.sql
--
-- Escrito en SQL plano en lugar de generado por un ORM: el esquema es parte de
-- lo que se evalúa en este proyecto, y un ORM pondría una capa entre lo que se
-- lee y lo que realmente se ejecuta.

-- --------------------------------------------------------------------------
-- users
-- --------------------------------------------------------------------------

CREATE TABLE users (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT        NOT NULL CHECK (btrim(name) <> ''),
  last_name  TEXT        NOT NULL CHECK (btrim(last_name) <> ''),
  email      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dos direcciones que solo difieren en mayúsculas/minúsculas son la misma
-- dirección. Un índice único sobre lower(email) en lugar de la extensión
-- citext: CREATE EXTENSION requiere un privilegio que el rol de la aplicación
-- deliberadamente no tiene, y un índice de expresión no requiere ninguno.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- --------------------------------------------------------------------------
-- tasks
-- --------------------------------------------------------------------------

CREATE TYPE task_status AS ENUM ('open', 'archived');

CREATE TABLE tasks (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       TEXT        NOT NULL CHECK (btrim(title) <> ''),
  description TEXT,
  status      task_status NOT NULL DEFAULT 'open',
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Una tarea está archivada exactamente cuando tiene una hora de archivado.
  -- Declararlo acá impide que algún camino de código deje a ambos en desacuerdo.
  CONSTRAINT archived_at_matches_status
    CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE INDEX tasks_status_idx ON tasks (status);

-- --------------------------------------------------------------------------
-- task_assignments
-- --------------------------------------------------------------------------

-- Una fila por persona por tarea. La clave primaria compuesta es lo que hace
-- que asignar dos veces al mismo usuario sea imposible y no solo desalentado:
-- POST /tasks/:id/assign puede insertar a ciegas y dejar que la clave decida.
CREATE TABLE task_assignments (
  task_id      BIGINT      NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (task_id, user_id)
);

-- La clave primaria ya sirve para búsquedas por tarea. Este índice sirve a
-- GET /users/:id/tasks, que lee en el sentido contrario.
CREATE INDEX task_assignments_user_id_idx ON task_assignments (user_id);

-- --------------------------------------------------------------------------
-- notification_attempts
-- --------------------------------------------------------------------------

-- Cada intento de notificar al sistema cliente que una tarea fue archivada,
-- haya tenido éxito o no. Se lee de vuelta en GET /tasks/:id/notifications.
CREATE TABLE notification_attempts (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id        BIGINT      NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  attempt_number INT         NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Null cuando el destino nunca respondió: un timeout no tiene código de estado.
  http_status    INT,
  error          TEXT,

  -- Como máximo tres intentos, cada uno registrado una sola vez. Si algún bucle
  -- de reintentos llegara a correr dos veces para la misma tarea, esta
  -- restricción es lo que lo delata, en lugar de que la tabla crezca en silencio.
  UNIQUE (task_id, attempt_number)
);

CREATE INDEX notification_attempts_task_id_idx ON notification_attempts (task_id);

-- --------------------------------------------------------------------------
-- idempotency_keys
-- --------------------------------------------------------------------------

CREATE TYPE idempotency_state AS ENUM ('in_progress', 'completed');

-- Una fila por (key, endpoint). La fila se reclama antes de que el trabajo se
-- ejecute, lo que permite que una segunda petición que llega en paralelo
-- bloquee sobre ella en lugar de ejecutar la operación por segunda vez.
--
-- request_hash existe para que la misma key enviada con un cuerpo distinto sea
-- rechazada, en lugar de repetir en silencio una respuesta a una pregunta que
-- nadie hizo.
CREATE TABLE idempotency_keys (
  key             TEXT              NOT NULL,
  endpoint        TEXT              NOT NULL,
  request_hash    TEXT              NOT NULL,
  state           idempotency_state NOT NULL DEFAULT 'in_progress',
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ       NOT NULL DEFAULT now(),
  PRIMARY KEY (key, endpoint),

  CONSTRAINT completed_rows_carry_a_response
    CHECK (state = 'in_progress'
           OR (response_status IS NOT NULL AND response_body IS NOT NULL))
);
