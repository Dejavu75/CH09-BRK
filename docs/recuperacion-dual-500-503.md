# Recuperación de errores persistentes 500 y 503 en modo dual

El mantenimiento y el warmup registran ahora HTTP 500 y HTTP 503 persistentes
para programar el reciclado dirigido del backend afectado, sin depender de
que llegue una solicitud de usuario al proxy.

## Regla

- Se conserva el umbral existente: dos conexiones distintas del mismo backend
  deben terminar sus intentos de inicialización con estado de error 500 o 503.
  Repetir el fallo de una sola conexión no aumenta el contador.
- Se admiten combinaciones de 500 y 503 dentro del mismo backend. No se suman
  conexiones de A y B. Un éxito u otro resultado retira la conexión del grupo.
- Se espera que termine el warmup y se libere mantenimiento antes de iniciar
  el drenaje. La solicitud de recuperación queda deduplicada por backend.
- El ciclo existente exige un peer activo y con todas las conexiones necesarias
  listas, retira del enrutamiento el backend afectado y espera que finalicen sus
  operaciones antes de reciclar su AppPool. El peer continúa atendiendo.
- Si ambos backends fallan o no hay peer sano, no se fuerza el reciclado ni
  se ejecuta un reinicio global de IIS.

No se cambian los contratos HTTP, el tratamiento de errores puntuales de una
solicitud de negocio ni el camino anterior de recuperación legacy.

## Comprobaciones

`Tests/dual_maintenance_errors.test.js` utiliza un servidor HTTP local real:
warmup 500 y 503 sin tráfico externo, mantenimiento 503 con operación activa,
atención por el peer durante drenaje, errores mixtos y rechazo sin peer sano.
Se adaptaron los tests de exclusión para utilizar 502, que continúa fuera de
la regla. Las pruebas anteriores dual y legacy deben seguir aprobadas.

## Alcance operativo

El 27/10/2026 se comprobó por SSH que el contenedor de producción de Merclin
tiene `HAAGES_A` y `HAAGES_B` configuradas: corresponde al modo dual.
La clasificación anterior como legacy no estaba sustentada; el campo `host`
del log de warmup no identifica el modo operativo.

La publicación de la imagen no implica por sí sola su activación en cada cliente. La imagen correctiva local de Merclin del 26/10 contenía únicamente
la corrección legacy y no incorpora este cambio dual.

Risk: item 4 (drenaje, deduplicación y coordinación de recuperación).
