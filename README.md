# CH09-BRK AGES Broker

Broker stateful entre clientes externos y AGES. Mantiene pools de sesiones AGES
precalentadas, separa llamadas `mini` y `bigb`, agrega trazabilidad y expone
rutas operativas para salud, pool, proxy AGES y administración controlada.

El límite máximo del cuerpo HTTP se configura con `REQUEST_BODY_LIMIT`. Si no
se define, el Broker acepta hasta `100mb` tanto para el proxy AGES como para
las solicitudes JSON.

## Camino rápido

```bash
npm install
npm run tsc
npm start
```

Para build de imagen:

```bash
npm run build
```

## Login y estado persistente

La imagen incluye dos cuentas generales de Broker: `guillermo.negrete` y `diego.zacur`. Sus contraseñas no se documentan ni se incluyen en texto plano en la imagen; el Broker verifica hashes bcrypt. BackGES no se modifica ni se usa como fuente de usuarios. No hace falta crear ni montar un archivo htpasswd al instalar el Broker. Las cuentas son iguales en todas las instalaciones, de modo que deben tratarse como credenciales compartidas entre empresas.

`BROKER_STATE_HOST_PATH` debe ser un directorio persistente y privado del guest `ges01`, por ejemplo `/srv/solinges/ecosystem/ch09-brk/state` (modo 0700). Los archivos `sessions.sqlite` y `timings.sqlite` viven allí; conservar el directorio entero, incluidos los posibles archivos SQLite WAL/SHM, al recrear el contenedor. El bind mount usa `create_host_path: false` para impedir que Docker cree silenciosamente un directorio equivocado. En una instalación no Compose, configurar las rutas internas `BROKER_AUTH_DB_PATH` y `BROKER_TIMINGS_DB_PATH`. La ausencia del origen HTTPS, clave de servicio o estado escribible impide el arranque.

Configurar `BROKER_PUBLIC_ORIGIN` con el origen HTTPS exacto que usa el
navegador (esquema, host y puerto si corresponde, sin barra final). Generar
`BROKER_SERVICE_API_KEY` como secreto aleatorio de al menos 32 bytes,
guardarlo fuera de Git y enviarlo en `X-Broker-Service-Api-Key` desde cada
consumidor automatizado de AGES y heartbeat. No reutilizar la clave de
administración anterior. Antes de activar, actualizar los consumidores y
verificar que sus peticiones autenticadas todavía llegan al upstream; de lo
contrario la nueva compuerta devolverá 401.

El challenge ACME es la única excepción HTTP. Login, sesión, páginas y rutas
de máquina responden 403 por HTTP, sin redirección que pueda reenviar
credenciales. Si producción publica solamente el puerto HTTP del contenedor,
debe existir un terminador TLS confiable delante del Broker y su IP exacta
debe estar en `BROKER_TRUSTED_PROXY_IPS`; ese proxy debe sobrescribir
`X-Forwarded-Proto` con `https` únicamente para conexiones TLS y bloquear
el acceso directo de clientes al puerto interno. Sin TLS directo o ese proxy
configurado, la instalación falla cerrada para todas las rutas protegidas.

`/auth/login` ofrece el acceso humano. Las páginas de pool, timings y
administración requieren sesión de navegador; los proxy endpoints `/ages`,
`/foreign/broker/ages`, health y heartbeat requieren la clave de servicio.
El challenge `/.well-known/acme-challenge` permanece público para ACME.
Las sesiones usan cookie Secure/HttpOnly/SameSite=Strict, CSRF y una duración
de 30 días: es una decisión más restrictiva que los 365 días observados en
el runtime actual de BackGES. Las cuentas son propias del Broker y no comparten sesión con BackGES: esto **no es SSO**. La vista de timings ahora omite cuerpos,
parámetros de URL y headers no aprobados antes de mostrar o persistir datos.
El historial de timings no elimina registros por cantidad: queda en SQLite
hasta que un operador use **Limpiar**. `GET /foreign/broker/pool/timings`
devuelve `{ rows, liveRows?, nextCursor }`: `rows` contiene hasta 100 registros
finalizados por página, ordenados del más reciente al más antiguo; continuar
con `?cursor=<nextCursor>`. La primera página puede incluir además hasta 100
llamadas en curso en `liveRows`, que no forman parte del cursor persistente.
La vista sólo muestra una página de historial a la vez. Se debe monitorear
espacio en disco y conservar
backups del volumen persistente según la política operativa.

El login limita intentos por IP cliente. Un barrido periódico, acotado a 1.000
entradas por ciclo, elimina intentos vencidos y sesiones caducadas del estado
persistente sin cerrar sesiones activas. Sin configuración adicional se usa
la IP del socket directo y se ignoran los headers de reenvío. Si hay un proxy
inverso, fijar `BROKER_TRUSTED_PROXY_IPS` a sus direcciones IP concretas,
separadas por comas; no admite rangos ni `trust proxy=true`. Configurar y
verificar que el proxy elimina/sobrescribe los headers `X-Forwarded-*` que
recibe del exterior. Un valor ausente detrás de Nginx agrupa a los usuarios
en un mismo límite de intentos; uno demasiado amplio permite falsificar IPs.

Antes de cualquier recreación, confirmar que ambos paths resuelven en el
filesystem local del guest, que el archivo de usuarios no es un symlink y
que existe una copia de seguridad verificable del directorio de estado.
Validar Compose con `docker compose config --quiet` y probar login, rechazo
sin credenciales, ACME y persistencia tras recreación. Esta documentación no
autoriza ni ejecuta una instalación; los scripts existentes que usan `/mnt`
no deben invocarse para esta migración.

## Contrato público

| Área | Valor |
|---|---|
| Servicio previsto | `https://api.solinges.com.ar/foreign/broker` |
| Atajo AGES publicado | `https://nages.solinges.com.ar/ages/` |
| Local default | `http://localhost:41048` |
| Puerto contenedor | `41048` |
| MSCode | `CH09-2` |

> Nota: el SSD registra que `/ages/` estaba publicado en `nages.solinges.com.ar`
> y que `/foreign/broker` era el destino previsto, pero no estaba confirmado en
> el nginx actual al momento del baseline.

## Fuente de verdad

- Spec funcional/operativa: [`SSD.md`](SSD.md)
- OpenAPI: `postman/CH09-BRK.openapi.json`
- Postman: `postman/CH09-BRK.postman_collection.json`
- Config local: `default.env`
- Rutas principales: `src/routes/rou_broker.ts`

## Verificación operativa

Revisar primero:

1. que el servicio arranque con `npm start`;
2. que el health responda en el puerto configurado;
3. que el pool tenga slots `ready` antes de declarar el broker operativo;
4. que los artefactos Postman/OpenAPI coincidan con `SSD.md`.

## Upstream AGES dual opcional

`HAAGES` conserva el comportamiento existente. Para repartir slots entre dos upstreams
independientes, configurar juntas `HAAGES_A` y `HAAGES_B`; una configuración parcial o
una URL que no sea HTTP(S) impide el arranque. Cada slot mantiene permanentemente su
backend, token y cookie de sesión. `GET /pool` muestra el modo y la afinidad resultante.

En modo dual, cada backend informa su estado (`active`, `draining`, `recycling`,
`warming` o `degraded`). `POST /pool/backends/A/drain-recycle` (o `B`) requiere
`X-Broker-Admin-Api-Key`, drena esa mitad y reinicia únicamente el AppPool indicado
por `AGES_IIS_APP_POOL_A/B`. El nombre acepta sólo letras, números, `_`, `-` y `.`;
no se aceptan comandos configurables. Ajustar el drenaje y SSH con
`AGES_BACKEND_DRAIN_TIMEOUT_SECONDS` y `AGES_SSH_COMMAND_TIMEOUT_SECONDS`.

El reciclado automático dual se limita a respuestas HTTP 503 correlacionadas con un
slot. Detectar automáticamente el HTTP 500 del error COM queda como seguimiento.

### Identidad SSH del broker

La imagen no genera ni contiene claves SSH. La identidad se crea una sola vez en el
host Docker, queda persistida fuera del contenedor y se monta en modo de solo lectura.
En un host Linux, definir las dos rutas persistentes y ejecutar:

```bash
export SSH_KEY_HOST_PATH=/srv/solinges/ecosystem/ch09-brk/keys
export SSH_PUBLIC_KEY_HOST_PATH=/srv/solinges/ecosystem/ch09-brk/ssh-public
./scripts/setup-broker-iis-ssh-key.sh
```

El script conserva un par existente, rechaza estados parciales o claves que no
coincidan y exporta solamente `ssh-public/ch09_brk_iis.pub`. La clave privada
`keys/ch09_brk_iis` no se copia al servidor Windows, no se agrega a la imagen y el
Compose la monta mediante `${SSH_KEY_HOST_PATH}:/run/secrets/ch09-brk-iis:ro`.
El arranque rechaza archivos simbólicos y pares ausentes o inconsistentes; después
copia la privada a un `tmpfs` interno con modo 600. Esto mantiene segura la clave
aunque Docker Desktop represente un bind de `C:` con modo 777 dentro de Linux.

Copiar **únicamente** `ch09_brk_iis.pub` al servidor IIS y, desde PowerShell elevado
en ese servidor, autorizarla con:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-broker-iis-public-key.ps1 `
  -PublicKeyPath C:\RutaTemporal\ch09_brk_iis.pub
```

El instalador rechaza reparse points, reemplaza la ACL y el propietario antes de
escribir, y verifica que `administrators_authorized_keys` permita exclusivamente
control total a Administradores y SYSTEM.
Después de verificar acceso con `BatchMode=yes`, borrar la copia pública temporal.

### Preparación IIS local

`scripts/provision-ages-dual-iis.ps1` prepara dos procesos IIS independientes sobre
la aplicación local `/AGES`, sin modificar el pool ni la aplicación `AGES` originales.
Primero ejecutar una inspección sin cambios:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-ages-dual-iis.ps1 -Mode Plan
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-ages-dual-iis.ps1 -Mode Validate
```

Cuando se autorice, abrir PowerShell **como administrador** y usar `-Mode Apply`.
Para retirar solamente los recursos registrados y todavía coincidentes con su
fingerprint, usar `-Mode Rollback`. El estado transaccional y las raíces vacías de los
sites quedan bajo `%ProgramData%\Solinges\CH09-BRK`; no borrarlos manualmente.
Si existe un ledger v1 junto al script, retirarlo primero con el provisioner v1.
`ages-dual.env.example` contiene las URLs y nombres de pool
que luego pueden copiarse al entorno local, sin secretos.

En SRI, repetir estos parámetros para `Plan`, `Apply`, `Validate` y `Rollback`:
`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-ages-dual-iis.ps1 -Mode Plan -ExpectedPath 'C:\Servidor\Solinges\AGES' -BindAddress '192.168.89.2' -SourceSite 'Default Web Site' -SourceApp 'AGES' -SourcePool 'AGES'`.
La aplicación hija `/AGES/log` no se clona porque las rutas del broker no dependen de ella.

## Enlaces del ecosistema

- Inventario global: `../../ECOSISTEMA_APIS_NODE_POSTMAN.md`
- Hosts y rutas: `../../ECOSISTEMA_ELEMENTOS_CONFIGURACION.md`
- Índice de contratos: `../../docs/service-contract-index.md`
