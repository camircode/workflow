# Dónde corre esto, y por qué así

El reto dice que el proveedor de hosting y la forma de despliegue son decisión
del candidato y forman parte de lo que se evalúa. Esta es la decisión, y el
razonamiento detrás.

No se eligió un PaaS. Un `git push` a Render habría puesto la API en línea en
diez minutos y no habría demostrado nada sobre despliegue: la parte interesante
la resuelve el proveedor y queda fuera de la vista. Sobre infraestructura propia
sí se puede mostrar entrega por digest inmutable, GitOps como única vía de
escritura al cluster, y secretos que nunca tocan un repositorio.

La contrapartida es honesta: hay más piezas que pueden fallar, y este documento
existe en parte para nombrarlas.

![Dónde corre la API](diagrams/despliegue.svg)

## Cuatro fronteras

Conviene leer la infraestructura como fronteras, no como una lista de
tecnologías. Cada una responde una pregunta distinta.

### 1. La frontera física — qué corre sobre qué

Un host Proxmox, `pve01`, con trece guests sobre un bridge interno `vmbr10` en
`10.10.10.0/24`.

El reparto entre LXC y máquina virtual no es estético. Un contenedor LXC
comparte kernel con el host, así que sirve para lo que es un servicio de
confianza: `data-01` con PostgreSQL, `edge-01`, el controlador de Jenkins. Una
máquina virtual tiene su propio kernel, así que se reserva para lo que ejecuta
código ajeno — el agente de Jenkins, que corre lo que traiga un pull request — y
para los nodos de Kubernetes.

El presupuesto es real y está escrito en el código: 49.5 GB asignados de 62 GiB.
La CPU está sobrecomprometida 33 vCPU sobre 16 hilos, a propósito, porque los
picos de los guests no coinciden. La memoria **no** está sobrecomprometida, y esa
asimetría también es a propósito: una CPU sobrecomprometida hace las cosas más
lentas, una memoria sobrecomprometida hace que el kernel elija a quién matar.

Los IDs de VM siguen a las direcciones: `100 + último octeto`. `pct exec 142`
opera sobre el guest que responde en `10.10.10.42`. Es una convención pequeña que
evita ir a buscar un mapeo en la mitad de un incidente.

### 2. La frontera de red — cómo entra una petición

El firewall del host hace DNAT de los puertos 80 y 443 directo al Gateway del
cluster en `10.10.10.200`. No hay un proxy TCP intermedio, y eso fue una
decisión, no un olvido: un proxy en modo TCP delante de un Gateway que termina
TLS pierde la dirección del cliente, y el Gateway API de Cilium no expone PROXY
protocol para recuperarla.

Hay dos Gateways separados **por dirección**, no por DNS. El motivo se descubrió
probando: con un solo Gateway, `curl --resolve argocd.camir.tech:443:<ip>`
llegaba igual a un servicio que debía ser privado. **El DNS no es una frontera**
— cualquiera puede afirmar cualquier nombre. La separación tiene que estar en la
dirección a la que se llega, y los nombres privados resuelven a una dirección
que sólo es enrutable por WireGuard.

Un detalle que costó una tarde y vale contar: dentro del cluster, la política de
red por defecto deniega todo el ingreso, y el permiso **no puede** ser una
`NetworkPolicy` común. El Gateway de Cilium pasa por Envoy, que alcanza los
backends bajo la identidad reservada `ingress`. Una `NetworkPolicy` sólo sabe
nombrar namespaces y rangos de IP, así que nunca coincide: el paquete se
descarta, Envoy responde `503 upstream connect error`, y la aplicación no
registra nada porque nada le llegó. Hace falta una `CiliumNetworkPolicy` con
`fromEntities: [ingress, host, remote-node]`.

Y una tercera frontera, la que separa la red de pods de la red del homelab.
Cilium corre con `ipv4NativeRoutingCIDR` fijado al rango de pods y masquerading
activado, de modo que **todo lo que un pod envía fuera de ese rango sale con la
dirección del nodo**. `data-01` ve `10.10.10.32`, nunca `10.244.x.y`. Las reglas
de `pg_hba.conf` y del firewall que permitían el rango de pods no podían
coincidir jamás, y como nftables descarta en vez de rechazar, el síntoma era un
timeout sin una sola línea de log de ninguno de los dos lados. Ahora las reglas
nombran a los nodos, derivados del inventario.

### 3. La frontera de entrega — cómo llega el código

```
push → Jenkins → test, build, escaneo → GHCR por digest
                                           ↓ Jenkins commitea el digest
                                        camircode/gitops → Argo CD → cluster
```

Ningún humano corre `kubectl apply`. Argo CD es lo único que escribe en el
cluster, y lo único que cambia Jenkins es una línea en git — por eso el log de
`camircode/gitops` **es** el historial de despliegues, y un rollback es un
revert. El Image Updater de Argo está deshabilitado a propósito: si el digest lo
resolviera el cluster, el repositorio dejaría de describir lo que corre.

Las imágenes se referencian por digest y nunca por tag. Un tag es un puntero
mutable: dos pods arrancados con una hora de diferencia desde el mismo tag pueden
estar corriendo código distinto, y un rollback a un tag vuelve a lo que ese tag
signifique hoy.

El escaneo corre después del push y antes del commit a GitOps. Una imagen que lo
falla queda en el registry sin que nada la referencie, que es inofensivo;
escanear antes del push sería escanear una imagen construida de capas distintas
a la que se envía. El pipeline falla ante HIGH o CRITICAL **con fix disponible**
— fallar por una vulnerabilidad sin arreglo posible sólo entrena a la gente a
ignorar al escáner. Las excepciones viven en `.trivyignore.yaml`, cada una con un
argumento de alcanzabilidad y una fecha en la que deja de aplicar. Una excepción
sin fecha es una supresión, y una supresión es cómo un escáner deja de leerse.

### 4. La frontera del contenedor — qué puede hacer el proceso

Imagen distroless: sin shell, sin gestor de paquetes, sin más libc que la que
Node necesita. Quien consiga ejecución de código dentro llega a un lugar donde no
hay nada que usar.

- Usuario no-root declarado **en la imagen**, no sólo en el Deployment, así que
  la imagen es segura de correr aunque alguien olvide el `securityContext`.
- Sistema de archivos raíz de sólo lectura, con un `emptyDir` montado en `/tmp`
  en vez de desactivar la restricción.
- `capabilities: drop: ["ALL"]`, `allowPrivilegeEscalation: false`, seccomp
  `RuntimeDefault`.
- `requests` y `limits` declarados. Un pod sin `requests` se planifica como si
  fuera gratis y el nodo se entera de lo contrario bajo carga.
- Liveness y readiness en endpoints **distintos**. Liveness pregunta si el
  proceso se colgó y no toca la base: matar un contenedor porque su base de datos
  está lenta no ayuda a nadie y hace la base más lenta todavía. Readiness sí
  pregunta por la base, porque sin ella el pod no puede atender.

## Los secretos

La cadena completa, sin que la aplicación se entere nunca de que Bitwarden
existe:

```
bws (proyecto Infrastructure)
  └─ WORKFLOW_DB_PASSWORD     ← nace en la máquina que crea el rol
       └─ scripts/bws-env.sh  ← el único lector de secretos del repo de infra
            └─ rol Ansible k8s_platform → plantilla no_log → kubectl apply
                 └─ Secret en el namespace workflow
                      └─ Deployment · secretKeyRef → DATABASE_URL
```

Cada eslabón es una decisión:

- **Ningún secreto en una línea de comandos.** Queda en el historial del shell y
  en la salida de `ps`, donde lo lee cualquier usuario de la máquina. Todo va por
  entorno o por stdin, y el `Makefile` lo fuerza.
- **El token de acceso a Bitwarden vive fuera del árbol del repositorio.** El
  repositorio no puede filtrarlo porque no lo contiene.
- **La contraseña no la escribe un humano.** `openssl rand` en la máquina que
  crea el rol y de ahí directo a Bitwarden. Nadie la ve, nadie la tipea, y no hay
  nada que rotar por haberse compartido. El rol tampoco es superusuario: no puede
  leer la base de otra aplicación.
- **El repositorio GitOps no contiene ni un secreto.** Un token es justamente lo
  único que no puede vivir ahí, y por eso lo inyecta Ansible contra el control
  plane en vez de commitearlo.
- **`NOTIFY_URL` va en un ConfigMap.** No es un secreto. Meter cosas que no son
  secretas dentro de Secrets entrena a la gente a ignorar la diferencia.

Un límite conocido, dicho en voz alta: el Secret renderizado queda en el control
plane como un archivo de root en modo 0600. External Secrets Operator sincronizando
desde Bitwarden eliminaría ese archivo intermedio, y es el paso siguiente; no se
hizo acá para no meter un operador nuevo en el camino crítico de una entrega.

## El destino de las notificaciones

`NOTIFY_URL` apunta a un `go-httpbin` en el mismo namespace, no al request bin de
un tercero: una evaluación de siete días no debería depender de un servicio que
no opera nadie de este lado. Es interno — sin ruta, sin hostname, fijado por
digest, y alcanzable sólo desde la aplicación por política de red.

`/post` responde 200. Cambiando ese valor del ConfigMap a `/status/503`, la
siguiente tarea archivada registra tres intentos con esperas crecientes en vez de
uno exitoso: todo el contrato de reintentos, demostrable editando una línea del
estado deseado.

## Cómo mirar esto sin romperlo

```bash
kubectl -n workflow get pods
kubectl -n workflow logs -l app.kubernetes.io/name=workflow --tail=50
kubectl -n argocd get application workflow
```

`kubectl` es para leer. Si algo no rutea, el diagnóstico es
`hubble observe --namespace workflow --verdict DROPPED` **en el agente del nodo
donde corre el pod** — un descarte sólo se ve desde ahí.

Editar un objeto vivo no es diagnosticar: Argo CD lo revierte o reporta deriva
para siempre. Todo cambio de lo que corre es un commit.
