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

`BROKER_STATE_HOST_PATH` debe ser un directorio persistente y privado del guest `ges01`, por ejemplo `/srv/solinges/ecosystem/ch09-brk/state` (modo 0700). Los archivos `sessions.sqlite` y `timings.sqlite` viven allí; conservar el directorio entero, incluidos los posibles archivos SQLite WAL/SHM, al recrear el contenedor. El bind mount usa `create_host_path: false` para impedir que Docker cree silenciosamente un directorio equivocado. En una instalación no Compose, configurar las rutas internas `BROKER_AUTH_DB_PATH` y `BROKER_TIMINGS_DB_PATH`. Si ambas rutas faltan, la imagen usa `/etc/nages2/logdir/broker-state` exclusivamente cuando `/etc/nages2/logdir` es un mountpoint exacto, escribible, sin symlinks, con un tipo de filesystem local permitido y cuyo propietario sea el UID del proceso o, si el Broker corre como root, el operador confiable del volumen; el mount tampoco puede ser escribible por grupo u otros usuarios, y el subdirectorio privado debe pertenecer al mismo UID. De lo contrario aborta antes de abrir SQLite. Si sólo falta una ruta, la configuración sigue incompleta y no se aplica el fallback. No se cambia el modo del directorio compartido de logs; el subdirectorio privado usa 0700 y la máscara de creación 077 protege los sidecars. Esta comprobación dentro del contenedor NO demuestra que el origen del bind esté realmente en el disco guest-local: Compose con bind corto puede crear un directorio vacío, y la rotación de logs podría eliminar el estado. Verificar el origen y la persistencia al instalar. El propietario del directorio de logs puede reemplazar el subdirectorio de estado, incluso si éste pertenece a root y tiene modo 0700; por eso aceptalo sólo si confiás en ese operador. Si no configurás `BROKER_SERVICE_API_KEY`, el Broker genera una clave aleatoria y la conserva como `service-api-key` dentro del estado privado. Un estado ausente o inseguro impide el arranque; sin origen explícito o certificado local verificable, el acceso humano falla cerrado.

Configurar `BROKER_PUBLIC_ORIGIN` con el origen HTTPS exacto que usa el
navegador (esquema, host y puerto si corresponde, sin barra final). Si falta,
el Broker usa el `Host` de cada petición humana sólo cuando la conexión ya es
HTTPS según la política de proxy confiable y el nombre coincide con el
certificado TLS local configurado mediante SAN (incluidos wildcards válidos;
un Common Name sin SAN no alcanza). Conserva el
puerto externo del `Host`; no lo deduce de `PORT_SSL` ni usa
`X-Forwarded-Host`. Sin certificado local, `Host` certificado o HTTPS confiable,
el login y las rutas humanas responden 403. En modo proxy, verificar que éste
preserve el `Host` público, sobrescriba `X-Forwarded-Proto` y bloquee acceso
directo al puerto interno. Si el certificado existe sólo en el proxy externo,
configurar `BROKER_PUBLIC_ORIGIN` explícitamente. El certificado local se
recarga al reiniciar el Broker. Generar
`BROKER_SERVICE_API_KEY` puede proporcionarse explícitamente con al menos 32
bytes. Si falta, la imagen crea una clave de ese tamaño en el estado persistente
privado. Los consumidores autorizados de controles de máquina la envían en
`X-Broker-Service-Api-Key`; las llamadas que el Broker sólo retransmite a AGES
no la usan. Nunca publiques la clave ni la incluyas en Git.

Sólo `GET /foreign/broker/heartbeat/beat` admite el Bearer emitido por MS07.
El Broker lo consulta mediante HTTPS en
`https://ec.solinges.com.ar/healthmonitor/heartbeat/broker-beat/validate`:
exige respuesta explícita `{ "valid": true }`, no sigue redirecciones y niega
el latido ante timeout, error o respuesta ambigua. MS07 verifica firma HMAC,
issuer `solinges-ecosystem`, identidad `MS07`, audiencia exacta `broker`,
scope `broker:beat` y vigencia. El secreto HMAC permanece fuera del Broker; no
hace falta distribuirlo a cada ges01. Los Bearer no habilitan otras rutas del
Broker. Desplegá primero el endpoint de validación en MS07 y verificá desde
ges01 que NAGES sea alcanzable por HTTPS; si NAGES no responde, el latido falla
cerrado. Antes de activar, verificá también que AGES conserve su autenticación
y que los controles del Broker sigan rechazando clientes no autorizados.

El Broker acepta tráfico HTTP y HTTPS y no redirige ni rechaza una petición sólo
por su transporte. Las rutas mantienen sus compuertas propias: AGES decide la
autorización del proxy, los controles de máquina exigen su credencial y las
rutas humanas exigen sesión. Para acceso humano con cookies seguras se recomienda
TLS directo o un terminador TLS confiable; en modo proxy, su IP exacta debe estar
en `BROKER_TRUSTED_PROXY_IPS` y debe sobrescribir `X-Forwarded-Proto` según el
transporte real.

`/auth/login` ofrece el acceso humano. Las páginas de pool, timings y
administración requieren sesión de navegador. Las rutas de proxy AGES bajo
`/ages` y `/foreign/broker` no exigen sesión ni clave del Broker: AGES decide
su propia autorización y sus headers de credenciales se retransmiten. Los
controles explícitos del Broker bajo ambos prefijos (`/pool`, `/iis`,
`/ages-host`, `/health`, `/heartbeat`) mantienen sus respectivas compuertas;
el beat exacto admite además el token firmado de MS07 descrito arriba.
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

## Alias de centros de costos

Las rutas REST `tablas/centros_costos/centros` y
`tablas/centros_costos/subcentros`, bajo `/ages` o `/foreign/broker`,
apuntan a `otablas.oCentros.centros` y `otablas.oCentros.subcentros`.
El alias funciona con BigBoy y con el selector `~mini~`. No cambia la ruta
existente `tablas/centros/centros`, los prefijos de otros objetos ni los métodos
con guiones bajos. `oCentrosCostos` no es el objeto registrado en AVFP.

Esta correspondencia se verificó contra las fuentes AVFP locales el 2026-10-15;
no acredita la versión de una DLL desplegada ni reemplaza una prueba runtime.

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


## Token técnico del cliente en el proxy

El proxy externo conserva únicamente el `AGES_TOKEN` aportado por el cliente; si falta, no agrega el del slot. En login lo omite, aunque el cliente lo envíe. Esto no reemplaza `AGES_USER_TOKEN` ni la API key del cliente. Warmup, ping directo y solicitudes internas siguen usando el token técnico del slot; el beat Mini retransmitido por el proxy sigue la política externa.

La cookie `ASP.NET_SessionId` continúa ligada al slot. La captura de tokens y cookies de respuesta tampoco cambia: estas pruebas no demuestran aislamiento de identidad ni aceptación con DLL AGES reales. La normalización de headers duplicados conserva el comportamiento de `Headers`, sin agregar validación nueva.

Pruebas locales: `node --test Tests/token_forwarding.test.js Tests/proxy_request_body.test.js Tests/dual_backend_routing.test.js Tests/incremental_warmup.test.js`. Usá un entorno de pruebas sin configuración operativa; los upstreams de estas pruebas son simulados o efímeros en loopback. La suite completa y TypeScript siguen siendo comprobaciones separadas.
