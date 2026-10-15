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

- T1 — S1–S5 — ruta: inline, operación administrativa comprendida; estado: completada, comprobaciones propias y verificación independiente aprobadas para S1–S5; riesgo: item 1, eliminación de referencias; commit de recuperación: `6adb26000c544d6ef6fae21115ae6097b41cff40`; RDD: desactivado, entrega no administrada.

## Log

- L1 — 2026-10-15 — Pedido original: "Sí, usá mi sesión de gh para borrar esas 19 ramas remotas y limpiá las locales terminadas. Conservá la de token, recuperá el apéndice MS07 localmente sin publicar y no borres worktrees ni descartes cambios sin commit."
- L2 — La auditoría confirmó `main` remoto en `cb98a0e`, 19 ramas remotas terminadas y 28 referencias locales eliminables después de recuperar el apéndice. La rama de token no está integrada. La recuperación convierte `main` local atrasado en descendiente del `main` remoto, sin mover el remoto.
- L3 — El conector GitHub de Codex no ofrece eliminación de referencias; el usuario autorizó explícitamente GitHub CLI. La sesión activa corresponde a `Dejavu75`. El workflow de publicación responde a cambios de `main` remoto, por lo que no se realizará ningún push.
- L4 — RDD desactivado por preferencia del clon (`clone_local`); no se activará. No corresponde RED/GREEN funcional para eliminación administrativa y recuperación documental: se verificarán respaldo, referencias exactas, contenido e invariantes de preservación antes y después.
- L5 — Antes de eliminar se guardarán el bundle de todas las referencias, inventario remoto/local y manifiestos de archivos e índices fuera del repositorio. Los HEAD de worktrees se desvincularán en el mismo commit, sin cambiar sus archivos. La verificación independiente será de solo lectura.
- L6 — Respaldo creado y bundle verificado en `C:\Users\diego\.codex\backups\ch09-branches-20261015`. Inventario previo: 30 ramas locales, 20 remotas, 11 worktrees y 701 archivos verificados por hash; incluye índices, parches y archivos modificados. Las pruebas aisladas de desvinculación conservaron staged, unstaged, untracked y registros de worktrees ausentes.
- L7 — Recuperación local `6adb260`: documento de main remoto conservado byte por byte y apéndice original de 30 líneas agregado al final, más este registro. Se empleó un índice temporal; ningún índice de los worktrees fue reutilizado. No se realizó push.
- L8 — Se eliminaron las 19 ramas remotas auditadas mediante GitHub CLI, verificando su SHA inmediatamente antes de cada DELETE. Luego se desvincularon los nueve HEAD asociados y se eliminaron 28 ramas locales anteriores y la rama temporal de recuperación. Se retiraron únicamente sus 19 referencias de seguimiento remoto, conservando `origin/main` y `origin/HEAD`.
- L9 — Comprobaciones propias aprobadas: permanecen solamente `main` y `codex/broker-client-token-only` localmente; solamente `main` en GitHub. Los once worktrees conservan su commit, existencia, índice, estado y archivos originales; cero diferencias de preservación. `main` remoto sigue en `cb98a0e`. `git diff --check cb98a0e main` aprobado. Falta la verificación independiente.
- L10 — Verificación independiente de solo lectura aprobada para S1–S5: lista remota actual, ambas ramas locales, conservación de todos los tips originales en el bundle, apéndice exacto y documento base intacto, once índices, nueve estados de worktrees existentes y 701 entradas del manifiesto (700 archivos y una ausencia previa). ZIP, parches e índices de respaldo íntegros. Sin bloqueantes; el archivo ya ausente `Tests/secure_transport.test.js` continúa ausente y no constituye una pérdida.
- L11 — Cierre exclusivamente documental local. No se ejecutaron builds, pruebas de aplicación, publicaciones, reinicios, cambios remotos de main ni limpieza de archivos. Los worktrees permanecen en HEAD separado para no alterar su contenido. El respaldo permite restaurar los nombres y tips originales si se requiere.
