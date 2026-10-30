# Recuperación dual de último recurso y consolidación
Objetivo: recuperar AppPools secuencialmente ante caída dual persistente, sin reiniciar IIS global ni perder trabajo pendiente.
Rama: `feat/dual-last-resort-20261030`, base `79e7adc`; entrega local `ask-on-risk`, previsión 380 líneas; pruebas: TypeScript y Node test.

## Specs

- S1: "Implementá esa recuperación de último recurso, primero un AppPool y después el otro, con límites para evitar reinicios en bucle". Activar solamente ante 500/503 persistentes en ambos backends; reutilizar drenaje, reciclado y warmup. Confirmar primero A operativo antes de recuperar B. Supuesto conservador: si A falla, detener el ciclo.
- S2: "con límites para evitar reinicios en bucle". Supuesto de implementación: máximo dos ciclos por proceso, separados por al menos cinco minutos desde la finalización, incluso si fallan; ningún éxito ni warmup manual reinicia el presupuesto. No repetir solicitudes de negocio ni ejecutar IIS global. Validar concurrencia, drenaje y errores con servidores HTTP locales, sin SSH real.
- S3: "y seguí con la consolidación a main" y "coordinalo con el otro agente que está trabajando". Coordinar con el chat original, preservar todos los worktrees/WIP y preparar integración local desde main conocido. No modificar controles de autenticación/transporte, publicar, desplegar, eliminar ramas ni usar sesiones remotas sin autorización adicional.

## Tasks

- T1 — S1–S2 — inline (una unidad de comportamiento, sin motivo de escritor delegado) — implementada; RED 5 fallos/11, GREEN focal 33/33, TypeScript OK; commit por registrar. Risk: items 4 y 5 (serialización de recuperación y reinicio de AppPools).
- T2 — S1–S2 — verificador independiente (items 4 y 5) — aprobada; suite 157 PASS, 0 FAIL, 1 SKIP; diferencial público idéntico salvo flujo solicitado, compilación OK, dos probes adicionales aprobados y conservados como regresiones.
- T3 — S3 — inline, auditoría coordinada — en curso; commit e integración pendientes de evidencia y decisiones abiertas.

## Log

- L1 — 2026-10-30 — "Implementá esa recuperación de último recurso, primero un AppPool y después el otro, con límites para evitar reinicios en bucle, y seguí con la consolidación a main."
- L2 — 2026-10-30 — "coordinalo con el otro agente que está trabajando".
- L3 — El chat original confirmó auditoría read-only, sin merges ni despliegues concurrentes. Protección HTTPS fuera de la consolidación hasta decisión expresa. `origin/main` local incluye 1776153 y filtros; no se consultó el remoto. Contenedor local 743456f anterior al seguimiento de mantenimiento dual 500/503.
- L4 — Se creó worktree mediante Git porque la herramienta de la aplicación rechazó sourceRoot fuera de las carpetas del chat. Se preservó intacto el árbol principal sucio. RDD estaba desactivado en el clon; se respetará.
- L5 — Verificación independiente en scratch: TypeScript y suite completa 157 PASS, 0 FAIL, 1 SKIP (permisos POSIX no verificables en Windows). Diferencial base/candidato de flujos públicos sano, 503 con peer sano, manual y legacy idéntico; dato centinela sin cambios ante rechazo. Spot check del padre: dos probes adicionales 2/2 PASS; incorporados como regresiones.
- L6 — Corrección de auditoría del chat original: HTTP sin guard de transporte ya estaba integrado en 79e7adc por cb98a0e; no corresponde tratarlo como retiro pendiente ni restaurarlo. Filtros, dual 500/503 y límite 100 MB ya están integrados. El árbol viejo de auth revierte funciones actuales; centros WIP contradice alias de main. No se mezclan. Pendiente evaluable: recuperación legacy 503 sin commit.
