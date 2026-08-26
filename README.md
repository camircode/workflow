# Workflow API

Gestión de trabajo para equipos. Se crea una tarea, se asigna a varias personas,
cada una marca su parte como terminada, y la tarea se archiva sola —
exactamente una vez — cuando termina la última.

**En vivo:** https://workflow.camir.tech · **Documentación interactiva:** https://workflow.camir.tech/docs

## Cómo ejecutarlo en local

Requiere Node 24, pnpm y Docker.

```bash
pnpm install
docker run -d --name wf -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=workflow -p 5432:5432 postgres:17-alpine
cp .env.example .env          # y completar DATABASE_URL y NOTIFY_URL
pnpm db:migrate
pnpm dev
```

`NOTIFY_URL` es obligatoria y no tiene valor por defecto. Un default haría que un
despliegue mal configurado pareciera sano hasta que alguien fuera a buscar
notificaciones que nunca se enviaron a ninguna parte; el proceso prefiere no
arrancar. Apuntala a cualquier receptor: el sistema externo no necesita existir,
y los intentos fallidos quedan registrados igual en
`GET /tasks/:idTask/notifications`.

## Tests

```bash
pnpm test
```

53 tests. Levantan un PostgreSQL real con Testcontainers, así que Docker tiene
que estar corriendo. No es un mock ni SQLite: todo lo que este proyecto promete
sobre peticiones concurrentes lo hace cumplir PostgreSQL — locks de fila, locks
consultivos, un `UPDATE` condicional que sólo una transacción puede ganar. Un
doble le daría la razón a cada una de esas afirmaciones sin comprobar ninguna.

## Las tres partes difíciles

![Archivado exactamente una vez](docs/diagrams/archivado.svg)

**Idempotencia con peticiones en paralelo.** `INSERT ... ON CONFLICT DO NOTHING`
por sí solo deja al perdedor sin fila y sin nada que leer, porque el ganador
todavía no hizo commit; agregarle `SELECT ... FOR UPDATE` tampoco alcanza,
porque bajo READ COMMITTED no hay fila visible que bloquear. Un lock consultivo
de transacción sobre la clave sí: el segundo se bloquea hasta que la primera
transacción termina y recién entonces mira, y o replica la respuesta guardada o
—si aquella hizo rollback— pasa a ser el dueño de la operación.

**Archivar exactamente una vez.** Dos cosas. Cada `complete` toma un lock de
fila sobre la tarea, porque si no, dos personas terminando las dos últimas
partes leen cada una el trabajo sin commitear de la otra como pendiente y *no
archiva ninguna*. Después, un único `UPDATE` condicional decide, y la fila que
le entrega a exactamente un llamador es la licencia para notificar.

**Notificaciones.** Se envían después del commit, nunca dentro: un lock de fila
no puede quedar tomado el tiempo que tarde en responder el servidor de un
tercero. Tres intentos, esperas crecientes, cada uno registrado en su propia
transacción. Eso deja una ventana: que el proceso muera entre el commit del
archivado y el primer intento. Una tarea archivada sin ningún intento registrado
es exactamente ese caso y ningún otro, así que el arranque las entrega — detrás
de un lock, para que dos réplicas no lo hagan las dos.

## La mejora: OpenAPI 3.1 y Swagger UI

En `/docs`, generada desde los mismos esquemas Zod que validan las peticiones.

*Qué problema resuelve.* Una API que nadie puede explorar se usa a fuerza de
adivinar. Ésta además tiene comportamiento que no se deduce de sus endpoints:
que todo `POST` acepta `Idempotency-Key`, y qué pasa si la misma clave llega dos
veces con cuerpos distintos.

*Por qué la consideré necesaria.* Una especificación escrita a mano es una
segunda fuente de verdad. Nace correcta y se desincroniza la primera vez que
alguien cambia un campo y se olvida, y una especificación equivocada es peor que
ninguna, porque se le cree. Una sola definición que valida la petición y a la
vez la describe elimina esa posibilidad.

*Por qué ésta y no otra.* La otra candidata eran logs estructurados y métricas,
que ayudan a quien opera esto. Pero la API se evalúa en vivo contra una URL, así
que la mejora que más rinde es la que permite ejercitarla desde el navegador en
lugar de armar `curl` a mano. Autenticación y rate limiting quedaron descartadas
de entrada: las dos romperían el acceso sin credenciales a los endpoints que se
están evaluando.

## Dónde está desplegada, y por qué

![Dónde corre la API](docs/diagrams/despliegue.svg)

Sobre un Proxmox propio: tres control planes de Kubernetes y dos workers, con
PostgreSQL en un guest aparte. No un PaaS, porque el reto hace de la decisión de
despliegue parte de lo que se evalúa, y sobre infraestructura propia se puede
demostrar entrega por digest inmutable, GitOps como única vía de escritura al
cluster, y secretos que nunca tocan el repositorio.

```
push → Jenkins → test, build, escaneo → GHCR por digest
                                           ↓ Jenkins commitea el digest
                                        camircode/gitops → Argo CD → Gateway API → https://workflow.camir.tech
```

Las imágenes se referencian por digest, nunca por tag: dos pods arrancados con
una hora de diferencia desde el mismo tag pueden estar corriendo código
distinto. La imagen es distroless y declara su usuario no-root en la imagen
misma, no sólo en el Deployment, y cada build se escanea — el pipeline falla
ante una vulnerabilidad HIGH o CRITICAL que tenga fix, antes de que el digest
llegue a GitOps. `DATABASE_URL` es un Secret de Kubernetes renderizado desde
Bitwarden Secrets Manager; la contraseña se genera en la máquina que crea el rol
y ningún humano la ve nunca. El relato completo está en
[docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).

## Supuestos, donde la especificación no decía

![Esquema de base de datos](docs/diagrams/schema.svg)

- **Misma `Idempotency-Key` con cuerpo distinto → 409.** Una clave nombra una
  petición. Responder con el resultado de la primera haría creer al llamador que
  pasó algo que nunca pasó. Los cuerpos se comparan ya validados, así que la
  misma petición con las claves en otro orden, o con espacios alrededor de un
  título, es la misma petición.
- **La cabecera se acepta, no se exige.** Exigirla rompería a todo cliente que no
  tiene problema de reintentos.
- **Completar una parte ya completada es éxito, no error**, y no archiva ni
  notifica de nuevo.
- **Asignar a una tarea archivada se rechaza** (409). Ya terminaron todos; no
  admite más cambios.
- **`GET /users/:idUser/tasks` responde 404 para un usuario inexistente**, en vez
  de una lista vacía: si no, un id mal tipeado parece un éxito plausible.
- **Una tarea sin nadie asignado nunca se archiva.** No tener partes pendientes
  no es lo mismo que estar terminada.
- **Un 4xx del destino de la notificación no se reintenta.** El mismo cuerpo no
  puede cambiar un rechazo; sólo un 5xx o la ausencia de respuesta merecen otro
  intento.
- **Los ids viajan como números JSON.** Son columnas `bigint`, pero ninguno se va
  a acercar a 2^53, y entrecomillarlos filtraría una decisión de almacenamiento
  que ningún consumidor puede explicar.

## Recortado por tiempo

- **Un outbox transaccional.** Escribir la notificación dentro de la transacción
  que archiva y drenarla desde un worker es la respuesta completa a la
  durabilidad; la reconciliación al arranque cierra la misma ventana a una
  fracción del costo, y el reto admite una sola mejora.
- **Paginación en los listados.** Correcto a este tamaño, incorrecto a partir de
  algún otro.
- **Rotación de contraseñas.** La del rol de base se crea una vez y queda en
  Bitwarden; rotarla es manual.
- **Un camino de migración más allá de la primera.** El runner aplica los
  archivos en orden y los registra, pero sólo existe una migración, así que sólo
  el camino hacia adelante está ejercitado.
