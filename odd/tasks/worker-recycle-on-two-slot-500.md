# Reiniciar worker ante dos slots con HTTP 500 al reciclar

## Objetivo y problema

Evitar que un worker IIS siga atendiendo con varios slots inutilizables cuando el reciclado individual vuelve a recibir HTTP 500. Hoy el broker registra cada fallo, pero no escala al worker.

## Alcance autorizado

- Cambiar sólo el código local de CH09-BRK y sus pruebas.
- Contar slots distintos cuyo reciclado termina en HTTP 500 dentro del mismo backend; con dos o más, reciclar el app pool IIS de ese backend mediante el ciclo dirigido existente.
- Retirar un slot del conjunto cuando se recupera y reiniciar el conjunto tras el reciclado del backend.
- No acceder, reiniciar ni desplegar en Lecar u otro servidor; no publicar ni hacer push.
- Conservar las protecciones actuales de drenaje, backend par disponible y exclusión de ciclos simultáneos. En modo legacy no inferir un reinicio global de IIS.

## Tareas

- [ ] **T1 — Escalada acotada por backend.** Incorporar el umbral de dos slots distintos con 500 al reciclar, programar el ciclo dirigido sin bloquear el mantenimiento del slot y cubrir recuperación, duplicados, separación A/B y exclusión de reinicios repetidos.
  - Ruta: delegada directa. Disparadores: preparación de escritura y dos archivos no triviales (`src/services/ages_pool.ts` y pruebas).
  - Aceptación: un solo slot o fallos A/B separados no reinician worker; dos slots distintos del mismo backend sí invocan una vez el reciclador del app pool apropiado; un reciclado exitoso quita al slot del conjunto; no hay espera circular.
  - Comprobaciones: prueba focal `node --test Tests/dual_backend_lifecycle.test.js` después de `npm run tsc`; suite `npm test`; `git diff --check`. Runtime remoto: no aplica, fuera del alcance autorizado.
  - Evidencia: pendiente.

## Modo y entrega

- TDD: no hay declaración explícita en la configuración inspeccionada; no se infiere por la existencia de pruebas. Se observará RED/GREEN para este cambio sin atribuir una preferencia de proyecto; validación funcional ordinaria igualmente obligatoria.
- Runner: `npm run tsc` seguido de `npm test` (`node --test Tests/*.test.js`).
- Estrategia de entrega: `ask-on-risk`; pronóstico aproximado: 160 líneas autorales, por debajo de 400. Conteo real: pendiente.
- Rama: `codex/worker-recycle-on-two-slot-500`, creada desde `5f3b5ab` para conservar cuatro commits locales aún no presentes en `main`.
- Próximo paso: implementar T1, ejecutar comprobaciones, registrar commit de unidad de trabajo y evaluar revisión nativa si corresponde.
