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

## Enlaces del ecosistema

- Inventario global: `../../ECOSISTEMA_APIS_NODE_POSTMAN.md`
- Hosts y rutas: `../../ECOSISTEMA_ELEMENTOS_CONFIGURACION.md`
- Índice de contratos: `../../docs/service-contract-index.md`
