# Limpieza de ramas terminadas del Broker
Objetivo: conservar el trabajo pendiente y recuperar el apéndice MS07 antes de eliminar las referencias terminadas.
Rama: `codex/broker-branch-cleanup`; entrega: `ask-on-risk`, solamente local; comprobaciones: Python, Git y GitHub CLI. Previsión: menos de 400 líneas documentales.

## Specs

- S1: "usá mi sesión de gh para borrar esas 19 ramas remotas". Eliminar solamente la lista auditada de `Dejavu75/CH09-BRK`, verificando cada SHA antes de actuar.
- S2: "limpiá las locales terminadas". Eliminar las referencias auditadas después de respaldarlas; conservar `main` y la rama pendiente.
- S3: "Conservá la de token". Mantener `codex/broker-client-token-only` en `5f3b5abef233d8eb6b3cbc88182c282c2dd97088`.
- S4: "recuperá el apéndice MS07 localmente sin publicar". Agregar únicamente las 30 líneas de `94c805a` al documento actual de `main` local; no modificar `main` remoto ni publicar imágenes.
- S5: "no borres worktrees ni descartes cambios sin commit.". Conservar los once registros y sus commits, índices y archivos. Desvincular las ramas mediante HEAD separado, sin checkout de archivos, reset, clean, stash ni prune.

## Tasks

- T1 — S1–S5 — ruta: inline, operación administrativa comprendida; estado: pendiente; riesgo: item 1, eliminación de referencias; verificación independiente posterior; commit: pendiente.

## Log

- L1 — 2026-10-15 — Pedido original: "Sí, usá mi sesión de gh para borrar esas 19 ramas remotas y limpiá las locales terminadas. Conservá la de token, recuperá el apéndice MS07 localmente sin publicar y no borres worktrees ni descartes cambios sin commit."
- L2 — La auditoría confirmó `main` remoto en `cb98a0e`, 19 ramas remotas terminadas y 28 referencias locales eliminables después de recuperar el apéndice. La rama de token no está integrada. La recuperación convierte `main` local atrasado en descendiente del `main` remoto, sin mover el remoto.
- L3 — El conector GitHub de Codex no ofrece eliminación de referencias; el usuario autorizó explícitamente GitHub CLI. La sesión activa corresponde a `Dejavu75`. El workflow de publicación responde a cambios de `main` remoto, por lo que no se realizará ningún push.
- L4 — RDD desactivado por preferencia del clon (`clone_local`); no se activará. No corresponde RED/GREEN funcional para eliminación administrativa y recuperación documental: se verificarán respaldo, referencias exactas, contenido e invariantes de preservación antes y después.
- L5 — Antes de eliminar se guardarán el bundle de todas las referencias, inventario remoto/local y manifiestos de archivos e índices fuera del repositorio. Los HEAD de worktrees se desvincularán en el mismo commit, sin cambiar sus archivos. La verificación independiente será de solo lectura.
