# CH09-BRK AGES Broker

Broker stateful entre clientes externos y AGES. Mantiene pools de sesiones AGES
precalentadas, separa llamadas `mini` y `bigb`, agrega trazabilidad y expone
rutas operativas para salud, pool, proxy AGES y administración controlada.

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
fingerprint, usar `-Mode Rollback`. El estado transaccional queda junto al script;
no borrarlo manualmente. `ages-dual.env.example` contiene las URLs y nombres de pool
que luego pueden copiarse al entorno local, sin secretos.

## Enlaces del ecosistema

- Inventario global: `../../ECOSISTEMA_APIS_NODE_POSTMAN.md`
- Hosts y rutas: `../../ECOSISTEMA_ELEMENTOS_CONFIGURACION.md`
- Índice de contratos: `../../docs/service-contract-index.md`
