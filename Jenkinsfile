// Builds the image, pushes it to GHCR by digest, and commits that digest to the
// GitOps repository.
//
// This pipeline never touches the cluster. Argo CD does the deploying, and the
// only thing Jenkins changes is a line in git — which is why the git log of
// camircode/gitops is the real deployment history.

pipeline {
    agent { label 'docker' }

    options {
        timestamps()
        timeout(time: 25, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    environment {
        REGISTRY = 'ghcr.io'
        IMAGE    = 'ghcr.io/camircode/workflow'
        GITOPS   = 'git@github.com:camircode/gitops.git'
        MANIFEST = 'manifests/workflow/deployment.yaml'
    }

    stages {
        stage('Test') {
            steps {
                // In a container rather than on the agent, so the agent does not
                // accumulate a toolchain per language it ever built.
                //
                // Three flags that are not decoration:
                //
                //   --network host and the docker socket, because the tests use
                //   Testcontainers. It starts a real PostgreSQL as a *sibling*
                //   container on the host daemon, and the test process reaches it
                //   on a published port — which only resolves from the host's
                //   network namespace.
                //
                //   --group-add, because the socket is group-readable and a uid
                //   mapped into a container brings none of its groups with it.
                //
                //   -u and HOME=/tmp, so node_modules is not left behind owned by
                //   root for cleanWs() to fail on, and corepack has somewhere to
                //   write.
                //
                //   /etc/passwd and /etc/group read-only, because a uid mapped in
                //   with -u does not exist inside the image. Testcontainers calls
                //   os.userInfo(), which is uv_os_get_passwd, and that fails with
                //   a bare ENOENT naming no path. Mounting the host's files makes
                //   the agent's own account resolvable. This does not reproduce on
                //   a workstation whose uid happens to be 1000 — node:24 already
                //   has a user there.
                sh '''
                    set -eu
                    DOCKER_GID="$(getent group docker | cut -d: -f3)"

                    docker run --rm \
                      --network host \
                      -v /var/run/docker.sock:/var/run/docker.sock \
                      --group-add "$DOCKER_GID" \
                      -u "$(id -u):$(id -g)" \
                      -v /etc/passwd:/etc/passwd:ro \
                      -v /etc/group:/etc/group:ro \
                      -e HOME=/tmp -e CI=true \
                      -v "$PWD":/src -w /src \
                      node:24 \
                      sh -c '
                        set -eu
                        # The directory has to exist first: corepack resolves it
                        # with realpathSync and fails with a bare ENOENT if it
                        # does not.
                        mkdir -p /tmp/bin
                        corepack enable --install-directory /tmp/bin
                        export PATH=/tmp/bin:$PATH
                        pnpm install --frozen-lockfile
                        pnpm typecheck
                        pnpm test
                      '
                '''
            }
        }

        stage('Build and push') {
            steps {
                // Computed in Groovy, not in the shell. `${VAR:0:7}` is a bash
                // substring and Jenkins runs `sh`, which on Debian is dash: it
                // answers "Bad substitution" and nothing else.
                script {
                    env.SHORT_SHA = env.GIT_COMMIT.take(7)
                }
                withCredentials([usernamePassword(
                    credentialsId: 'ghcr',
                    usernameVariable: 'GHCR_USER',
                    passwordVariable: 'GHCR_PASS',
                )]) {
                    sh '''
                        set -eu
                        echo "$GHCR_PASS" | docker login "$REGISTRY" -u "$GHCR_USER" --password-stdin

                        docker buildx create --use --name builder 2>/dev/null || docker buildx use builder

                        # The tag exists so a human can find the build; the digest
                        # is what gets deployed. --metadata-file is how the digest
                        # comes back without a second registry round trip.
                        docker buildx build \
                          --push \
                          --provenance=false \
                          --tag "$IMAGE:$SHORT_SHA" \
                          --metadata-file metadata.json \
                          .
                    '''
                }
                script {
                    def meta = readJSON file: 'metadata.json'
                    env.IMAGE_DIGEST = meta['containerimage.digest']
                    echo "Pushed ${env.IMAGE}@${env.IMAGE_DIGEST}"
                }
            }
        }

        stage('Smoke test') {
            steps {
                // Arrancar la imagen antes de commitear su digest.
                //
                // Existe por un fallo concreto: una vez el pipeline construyó,
                // escaneó y entregó a GitOps una imagen que no podía ejecutarse
                // —le faltaba el package.json donde vive el mapa de subrutas— y
                // se descubrió en el cluster, con el pod en CrashLoopBackOff. Que
                // la API no se cayera fue mérito del rollout, que mantuvo los
                // pods viejos sirviendo. El pipeline no lo vio.
                //
                // Los tests tampoco pueden verlo: corren sobre el código fuente,
                // no sobre la imagen, y esa clase de fallo sólo aparece al
                // arrancarla.
                //
                // Se ejecuta con el mismo usuario y el mismo sistema de archivos
                // de sólo lectura que aplica el Deployment, porque "funciona como
                // root" y "funciona como 10001 sin poder escribir" son cosas
                // distintas.
                //
                // Por digest, no por tag: lo que se prueba es exactamente lo que
                // se va a desplegar.
                sh '''
                    set -eu
                    NET="smoke-$BUILD_NUMBER"
                    DB="smoke-db-$BUILD_NUMBER"
                    APP="smoke-app-$BUILD_NUMBER"

                    cleanup() {
                      docker logs "$APP" 2>&1 | tail -30 || true
                      docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true
                      docker network rm "$NET" >/dev/null 2>&1 || true
                    }
                    trap cleanup EXIT

                    docker network create "$NET"
                    docker run -d --name "$DB" --network "$NET" \
                      -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=workflow \
                      postgres:17-alpine

                    for i in $(seq 1 60); do
                      docker exec "$DB" pg_isready -U postgres -d workflow >/dev/null 2>&1 && break
                      sleep 1
                    done

                    docker pull "${IMAGE}@${IMAGE_DIGEST}"
                    docker run -d --name "$APP" --network "$NET" \
                      --user 10001:10001 --read-only --tmpfs /tmp \
                      -e DATABASE_URL="postgresql://postgres:smoke@$DB:5432/workflow" \
                      -e NOTIFY_URL="https://smoke.invalid/hook" \
                      -e LISTEN_ADDR=":8080" \
                      "${IMAGE}@${IMAGE_DIGEST}"

                    # curl desde un contenedor en la misma red: el agente no
                    # necesita tener curl ni un puerto publicado.
                    probe() {
                      docker run --rm --network "$NET" curlimages/curl:latest \
                        -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://$APP:8080$1"
                    }

                    ok=""
                    for i in $(seq 1 45); do
                      if [ "$(probe /health || true)" = "200" ]; then ok=yes; break; fi
                      sleep 2
                    done
                    [ -n "$ok" ] || { echo "La imagen no llegó a responder en /health."; exit 1; }

                    # /ready abre una transacción, así que prueba que las
                    # migraciones corrieron y que el pool conecta.
                    [ "$(probe /ready)" = "200" ] || { echo "/ready no responde 200."; exit 1; }

                    # Y una escritura real, para cubrir enrutado, validación y base.
                    code=$(docker run --rm --network "$NET" curlimages/curl:latest \
                      -sS -o /dev/null -w '%{http_code}' --max-time 5 \
                      -XPOST "http://$APP:8080/users" \
                      -H 'content-type: application/json' \
                      -d '{"name":"Smoke","lastName":"Test","email":"smoke@example.com"}')
                    [ "$code" = "201" ] || { echo "POST /users respondió $code, se esperaba 201."; exit 1; }

                    echo "Smoke test correcto: la imagen arranca, migra y sirve."
                '''
            }
        }

        stage('Scan') {
            steps {
                // After the push and before the GitOps commit, deliberately. An
                // image that fails here exists in the registry and is never
                // referenced by anything, which is harmless — whereas scanning
                // before the push would mean scanning an image built from a
                // different set of layers than the one that shipped.
                //
                // --ignore-unfixed, because failing a build over a vulnerability
                // with no fix available teaches people to ignore the scanner. The
                // exceptions live in .trivyignore.yaml, each with a reachability
                // argument and a date it stops applying.
                withCredentials([usernamePassword(
                    credentialsId: 'ghcr',
                    usernameVariable: 'GHCR_USER',
                    passwordVariable: 'GHCR_PASS',
                )]) {
                    sh '''
                        set -eu
                        docker run --rm \
                          -e TRIVY_USERNAME="$GHCR_USER" \
                          -e TRIVY_PASSWORD="$GHCR_PASS" \
                          -v "$HOME/.cache/trivy:/root/.cache/" \
                          -v "$PWD/.trivyignore.yaml:/.trivyignore.yaml:ro" \
                          aquasec/trivy:latest image \
                            --scanners vuln \
                            --severity HIGH,CRITICAL \
                            --ignore-unfixed \
                            --ignorefile /.trivyignore.yaml \
                            --exit-code 1 \
                            "${IMAGE}@${IMAGE_DIGEST}"
                    '''
                }
            }
        }

        stage('Update the desired state') {
            steps {
                sshagent(credentials: ['gitops-write']) {
                    sh '''
                        set -eu
                        rm -rf gitops
                        GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" \
                          git clone --depth 1 "$GITOPS" gitops

                        cd gitops
                        git config user.email "jenkins@camir.tech"
                        git config user.name  "jenkins"

                        # Matches the repository rather than the old value, so the
                        # scaffold's :PLACEHOLDER, a previous digest and a
                        # hand-edited manifest are all corrected rather than one
                        # of them being silently skipped.
                        sed -i -E "s#image: ghcr\\.io/camircode/workflow[@:][^[:space:]]+#image: ${IMAGE}@${IMAGE_DIGEST}#" "$MANIFEST"

                        if git diff --quiet; then
                          echo "Already at ${IMAGE_DIGEST}; nothing to commit."
                          exit 0
                        fi

                        git add "$MANIFEST"
                        git commit -m "deploy(workflow): ${IMAGE_DIGEST}

Built from camircode/workflow@${GIT_COMMIT} by Jenkins build ${BUILD_NUMBER}."
                        GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" git push origin main
                    '''
                }
            }
        }
    }

    post {
        always {
            sh 'docker logout ghcr.io || true'
            cleanWs()
        }
    }
}
