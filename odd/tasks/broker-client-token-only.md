# Broker: AGES_TOKEN sólo si lo envía el cliente

> Registro histórico de c60bf69. La evidencia del candidato sobre main actual está en `broker-token-candidate.md`.

## Objetivo y problema

Evitar que una llamada externa sin `AGES_TOKEN` reciba el token interno del slot. Hoy `proxyCall` lo agrega o reemplaza, y una prueba fija ese comportamiento. El cliente debe conservar su propio token en llamadas comunes; el login debe seguir sin enviarlo. La cookie `ASP.NET_SessionId` del slot debe permanecer, según la aclaración de Diego.

## Alcance y restricciones

- Autorizado: corrección local del forwarding de `AGES_TOKEN` y sus pruebas.
- Fuera de alcance: cookie de sesión, `X-Forwarded-For`, `X-Real-IP`, FD03, publicación y despliegue.
- Rama: `codex/broker-client-token-only`, desde `010f23b`.
- Estrategia de entrega: `ask-on-risk`; pronóstico menor a 150 líneas autorales cambiadas.
- Ruta: delegada directa; `src/services/ages_pool.ts`, `Tests/dual_backend_routing.test.js` y `Tests/incremental_warmup.test.js` son archivos no triviales. Mapeo previo de cuatro archivos, incluidos Broker y FD03. La tercera prueba entró al alcance al fallar el suite por expectativas del contrato anterior.
- TDD: no hay modo explícito encontrado en proyecto/sesión; se ejecutan checks funcionales. Runner: `node --test Tests/dual_backend_routing.test.js`, `npm test`, `npm run tsc`.
- RDD: desactivado por preferencia local del clon (`gentle-ai review mode status`); entrega `disabled/unmanaged`.

## Tareas

- [ ] BRK-TOKEN-1: Preservar el token provisto por el cliente en llamadas externas comunes, omitirlo cuando falte, mantener la excepción de login, la cookie del slot y el token interno para operaciones propias del pool. Ajustar pruebas y registrar checks y commit.

## Aceptación y comprobaciones

- Una llamada externa común sin token no envía `AGES_TOKEN`.
- Una llamada externa común con token conserva exactamente el valor del cliente, no el del slot.
- Login no envía `AGES_TOKEN` aun si el cliente lo aportó.
- Warmup, ping y solicitudes internas del pool conservan su comportamiento; `ASP.NET_SessionId` sigue presente.
- Pasan la prueba enfocada, `npm test` y `npm run tsc`. La aceptación runtime y el despliegue quedan pendientes.

## Progreso y evidencia

- Diagnóstico: `buildSessionHeaders` inyecta el token del slot en toda llamada común; FD03 establece XFF/XRI, por lo que no se modifican.
- Implementación local: `proxyCall` usa el token del cliente en rutas comunes o ninguno cuando falta; login no envía token. Las operaciones propias del pool siguen usando el token del slot y su cookie.
- La primera corrida de `npm test` falló en cuatro casos de `Tests/incremental_warmup.test.js` porque esperaban el token del slot en llamadas externas. Se actualizaron esas expectativas del contrato anterior.
- Comprobaciones reportadas por el ejecutor: prueba focalizada `7/7`, `npm test` `61/61`, `npm run tsc` exit 0 y `git diff --check` sin errores.
- Próximo paso: revisar el diff y cerrar la unidad con un commit. Despliegue y aceptación runtime pendientes.
- Límite de rollback: revertir sólo el comportamiento de token externo y sus pruebas, sin tocar cookie ni autenticación interna.
