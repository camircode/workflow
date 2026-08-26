# Dónde corre esto

El reto dice que el proveedor de hosting y la forma de despliegue son decisión
del candidato y forman parte de lo que se evalúa. Este documento explica la
decisión y cómo está montado.

Descarté un PaaS. Un `git push` a Render habría puesto la API en línea en diez
minutos, con la parte interesante resuelta por el proveedor y fuera de la vista.
Sobre infraestructura propia puedo mostrar entrega por digest inmutable, GitOps
como única vía de escritura al cluster, y secretos que no pasan por ningún
repositorio. A cambio hay más piezas que pueden fallar, y las que fallaron están
descritas más abajo.

![Dónde corre la API](diagrams/despliegue.svg)

## La máquina y sus guests

Un host Proxmox, `pve01`, con trece guests sobre un bridge interno `vmbr10` en
`10.10.10.0/24`.

Los servicios de confianza corren en contenedores LXC: `data-01` con PostgreSQL,
`edge-01`, el controlador de Jenkins. Lo que ejecuta código de terceros corre en
máquinas virtuales con su propio kernel: el agente de Jenkins, que ejecuta lo que
traiga un pull request, y los nodos de Kubernetes.

El presupuesto asignado es de 49.5 GB sobre 62 GiB. La CPU está sobrecomprometida
33 vCPU sobre 16 hilos porque los picos de los guests no coinciden. La memoria no
lo está: cuando falta memoria, el kernel elige un proceso y lo mata.

Los IDs de VM siguen a las direcciones, con la regla `100 + último octeto`. Así
`pct exec 142` opera sobre el guest que responde en `10.10.10.42`.

## Cómo entra una petición

El firewall del host hace DNAT de los puertos 80 y 443 al Gateway del cluster en
`10.10.10.200`. No hay proxy TCP intermedio: uno delante de un Gateway que
termina TLS pierde la dirección del cliente, y el Gateway API de Cilium no expone
PROXY protocol para recuperarla.

Hay dos Gateways separados por dirección. La primera versión usaba uno solo y
separaba los servicios privados por nombre DNS, hasta que
`curl --resolve argocd.camir.tech:443:<ip>` llegó igual a uno de ellos. Los
nombres privados resuelven ahora a una dirección que sólo es enrutable por
WireGuard.

Dentro del cluster la política de red deniega todo el ingreso por defecto, y el
permiso tiene que ser una `CiliumNetworkPolicy`. El Gateway pasa por Envoy, que
alcanza los backends bajo la identidad reservada `ingress`. Una `NetworkPolicy`
común sólo sabe nombrar namespaces y rangos de IP, así que nunca coincide: el
paquete se descarta, Envoy responde `503 upstream connect error`, y la aplicación
no registra nada porque nada le llegó.

Hay una tercera frontera entre la red de pods y la red del homelab. Cilium corre
con `ipv4NativeRoutingCIDR` fijado al rango de pods y masquerading activado, así
que todo lo que un pod envía fuera de ese rango sale con la dirección del nodo.
`data-01` ve `10.10.10.32`. Las reglas de `pg_hba.conf` y del firewall permitían
el rango de pods y nunca podían coincidir; como nftables descarta en vez de
rechazar, el síntoma era un timeout sin registro en ninguno de los dos lados. Las
reglas nombran ahora a los nodos, tomados del inventario de Ansible.

## Cómo llega el código

```
push → Jenkins → test, build, escaneo → GHCR por digest
                                           ↓ Jenkins commitea el digest
                                        camircode/gitops → Argo CD → cluster
```

Argo CD es lo único que escribe en el cluster. Jenkins sólo cambia una línea en
git, así que el log de `camircode/gitops` funciona como historial de despliegues
y un rollback es un revert. El Image Updater de Argo está deshabilitado a
propósito, para que el repositorio siga describiendo lo que corre.

Las imágenes van por digest. Dos pods arrancados con una hora de diferencia desde
el mismo tag pueden estar corriendo código distinto, y un rollback a un tag
vuelve a lo que ese tag signifique hoy.

El escaneo corre después del push y antes del commit a GitOps. Una imagen que lo
falla queda en el registry sin que nada la referencie. El pipeline falla ante
HIGH o CRITICAL con arreglo disponible; fallar por vulnerabilidades sin arreglo
posible sólo consigue que la gente deje de mirar el informe. Las excepciones
están en `.trivyignore.yaml`, cada una con un argumento de alcanzabilidad y una
fecha de caducidad, para que vuelvan a aparecer si el arreglo no llegó.

## Qué puede hacer el contenedor

La imagen es distroless: sin shell, sin gestor de paquetes, sin más libc que la
que Node necesita.

- Usuario no-root declarado en la imagen, además de en el Deployment.
- Sistema de archivos raíz de sólo lectura, con un `emptyDir` montado en `/tmp`.
- `capabilities: drop: ["ALL"]`, `allowPrivilegeEscalation: false`, seccomp
  `RuntimeDefault`.
- `requests` y `limits` declarados.
- Liveness y readiness en endpoints distintos. Liveness no toca la base, para que
  una base lenta no provoque el reinicio del contenedor. Readiness sí la
  consulta.

## Los secretos

```
bws (proyecto Infrastructure)
  └─ WORKFLOW_DB_PASSWORD     ← se genera en la máquina que crea el rol
       └─ scripts/bws-env.sh  ← único lector de secretos del repo de infra
            └─ rol Ansible k8s_platform → plantilla no_log → kubectl apply
                 └─ Secret en el namespace workflow
                      └─ Deployment · secretKeyRef → DATABASE_URL
```

Ningún secreto viaja en una línea de comandos, porque quedaría en el historial
del shell y en la salida de `ps`. Todo pasa por entorno o por stdin, y el
`Makefile` lo fuerza.

El token de acceso a Bitwarden vive fuera del árbol del repositorio. La
contraseña de base la genera `openssl rand` en la máquina que crea el rol y va
directo a Bitwarden; nadie la escribe ni la lee. El rol no es superusuario y no
puede consultar la base de otra aplicación.

El repositorio GitOps no contiene secretos. Los inyecta Ansible contra el control
plane. `NOTIFY_URL` va en un ConfigMap, porque no es un secreto.

Queda un límite conocido: el Secret renderizado permanece en el control plane
como un archivo de root en modo 0600. External Secrets Operator sincronizando
desde Bitwarden eliminaría ese archivo, y es el paso siguiente.

## El destino de las notificaciones

`NOTIFY_URL` apunta a un `go-httpbin` en el mismo namespace, para que una
evaluación de siete días no dependa de un servicio de terceros. Es interno: sin
ruta, sin hostname, fijado por digest, y alcanzable sólo desde la aplicación.

`/post` responde 200. Cambiando ese valor del ConfigMap a `/status/503`, la
siguiente tarea archivada registra tres intentos con esperas crecientes.

## Vigilancia

`monitoring-01` sondea cada quince segundos las URLs publicadas y alerta si una
deja de responder, si tarda más de dos segundos, o si el propio sondeo se cae.
La sonda apunta al Gateway con el hostname en la cabecera `Host` y en el nombre
del certificado. Cubre el Gateway, el certificado y la aplicación; el DNS y la
regla de reenvío del host quedan fuera de lo que un guest de esta red puede
alcanzar.

## Cómo mirarlo

```bash
kubectl -n workflow get pods
kubectl -n workflow logs -l app.kubernetes.io/name=workflow --tail=50
kubectl -n argocd get application workflow
```

`kubectl` sirve para leer. Si algo no rutea, el diagnóstico es
`hubble observe --namespace workflow --verdict DROPPED` en el agente del nodo
donde corre el pod, que es el único sitio donde un descarte se ve.

Editar un objeto vivo no arregla nada: Argo CD lo revierte o reporta deriva
indefinidamente. Todo cambio de lo que corre pasa por un commit.
