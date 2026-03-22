# Natural Language Query Engine para cubos OLAP

Backend en Node.js / TypeScript que permite hacer preguntas en lenguaje natural sobre cubos SSAS (SQL Server Analysis Services) y obtener respuestas con datos reales del cubo, sin necesidad de conocer MDX ni la estructura interna.

---

## Qué hace

1. El usuario escribe una pregunta en español: _"cuántas matriculaciones hay de Ford en 2026"_
2. El sistema detecta las métricas y filtros implicados (sin hardcodear cubos ni dimensiones)
3. Genera y ejecuta MDX contra SSAS directamente
4. Responde en lenguaje natural con el dato real: _"Matriculaciones YTD es 252873 en 2026"_

Todo el historial de conversación se guarda en SQL Server para persistencia entre sesiones.

---

## Arquitectura

```
Usuario (chat UI / curl)
        │
        ▼
 Express API  (puerto configurado por PORT)
        │
   ┌────┴────────────────────────────────────────┐
   │                                              │
POST /ask              POST /api/chat/ask         │
   │                         │                   │
   └────────────┬────────────┘                   │
                ▼                                 │
        runAskPipeline()                         │
       (askController.ts)                         │
                │                                 │
    ┌───────────▼───────────┐                    │
    │  1. Planificador      │                    │
    │  - splitIntents()     │  detecta intenciones│
    │  - extractFilterHints │  detecta filtros   │
    │  - extractYear()      │  detecta año       │
    └───────────┬───────────┘                    │
                │                                 │
    ┌───────────▼───────────┐                    │
    │  2. Selección métrica │                    │
    │  - Pinecone (vectores)│  candidatos semánt.│
    │  - scoreMeasure()     │  ranking léxico    │
    │  - entity coherence   │  filtro por ent.   │
    └───────────┬───────────┘                    │
                │                                 │
    ┌───────────▼───────────┐                    │
    │  3. Resolución filtros│                    │
    │  - manifest XMLA      │  dimensiones/miembros│
    │  - MDSCHEMA_MEMBERS   │  búsqueda live     │
    │  - implicit context   │  si está en nombre │
    └───────────┬───────────┘                    │
                │                                 │
    ┌───────────▼───────────┐                    │
    │  4. Ejecución MDX     │                    │
    │  - mdxBridgeService   │                    │
    │  - SSAS msmdpump.dll  │                    │
    └───────────┬───────────┘                    │
                │                                 │
    ┌───────────▼───────────┐                    │
    │  5. Respuesta natural │                    │
    │  - buildNaturalAnswer │                    │
    └───────────────────────┘                    │
                                                  │
   GET /chat  ──► public/chat.html               │
   /api/chat/*  ──► chatController.ts            │
   /api/debug/* ──► debugController.ts           │
                                                  │
 SQL Server ◄──── chatPersistenceService.ts      │
 (conversations + messages)                       │
```

---

## Componentes principales

### Controladores (`src/controllers/`)

| Archivo | Ruta(s) | Función |
|---|---|---|
| `askController.ts` | `POST /ask` | Pipeline principal de lenguaje natural. Exporta también `runAskPipeline()` para reutilización interna. |
| `chatController.ts` | `POST /api/chat/ask`, `GET /api/chat/conversations`, `POST /api/chat/conversations`, `GET /api/chat/conversations/:id/messages` | Gestión de conversaciones persistidas con historial en SQL Server. |
| `debugController.ts` | `GET /api/debug/logs` | Expone logs de trazabilidad de cada pregunta (eventos, ranking de métricas, MDX ejecutado, etc.) |
| `queryController.ts` | `POST /query` | Endpoint alternativo de consulta (modo Cube.dev API). |

### Servicios (`src/services/`)

| Archivo | Función |
|---|---|
| `mdxBridgeService.ts` | Convierte preguntas en MDX, ejecuta contra SSAS por XMLA SOAP. Incluye `findBestMemberByCaption()` para resolución dinámica de miembros de dimensión. |
| `metadataService.ts` | Lee archivos `schema/*.js`, extrae medidas/dimensiones y las indexa/busca en Pinecone. Fallback a embeddings locales determinísticos si Azure OpenAI no está disponible. |
| `xmlaSyncService.ts` | Descubre metadata de SSAS (catálogos, cubos, medidas, dimensiones) vía XMLA y genera archivos de schema para Cube.dev y el manifest `.xmla-manifest.json`. |
| `chatPersistenceService.ts` | Crea y gestiona las tablas `dbo.conversations` y `dbo.messages` en SQL Server. Se adapta al esquema existente (añade columnas sin romper tablas existentes). |
| `sqlServerClient.ts` | Pool de conexión compartido a SQL Server (reutilizado por Cube.dev y el chat). |
| `debugLogger.ts` | Escribe eventos estructurados en `logs/ask-debug.jsonl` y `logs/chat-debug.jsonl` con `traceId` por petición. |
| `azureOpenAIClient.ts` | Cliente para embeddings (`text-embedding-3-small`) y chat completions (`GPT-4o`) de Azure OpenAI. |
| `azureAiProjectsClient.ts` | Cliente para agentes de Azure AI Projects (alternativa/fallback LLM). |
| `cubeServer.ts` | Arranca Cube.dev embebido con driver MSSQL, apuntando a los schemas locales. |
| `pineconeClient.ts` | Wrapper para upsert y query en Pinecone (batch de 100 vectores). |

### Scripts de mantenimiento (`src/scripts/`)

| Script | Comando npm | Función |
|---|---|---|
| `syncXmlaMetadata.ts` | `npm run sync-xmla-metadata` | Descubre catálogos/cubos/medidas/dimensiones de SSAS, genera schemas y los indexa en Pinecone. **Ejecutar al añadir nuevos cubos.** |
| `indexMetadata.ts` | `npm run index-metadata` | Re-indexa solo los schemas locales (`schema/*.js`) en Pinecone sin redescubrir SSAS. |
| `bootstrapCubeLocalTable.ts` | `npm run bootstrap-cube-local-table` | Crea la tabla de prueba `dbo.cube_dev_local_bridge` en SQL Server local. |
| `validateCubeLocalSetup.ts` | `npm run validate-cube-local` | Verifica variables de entorno de Cube.dev y conexión a SQL Server. |
| `testMssqlConnection.ts` | `npm run test-mssql-connection` | Prueba conexión directa a SQL Server. |
| `testMdxBridge.ts` | `npm run test-mdx-bridge` | Prueba traducción Cube.js query → MDX y ejecución contra SSAS. |
| `testCubeClient.ts` | `npm run test-cube-client` | Prueba query contra el Cube.dev local embebido. |
| `testExistingAgent.ts` | `npm run test-existing-agent` | Prueba conectividad con un agente Azure AI Projects. |

### Datos persistidos

| Recurso | Ubicación |
|---|---|
| Schemas de cubos (Cube.dev) | `schema/*.js` (generados por `sync-xmla-metadata`) |
| Manifest XMLA | `schema/.xmla-manifest.json` (mapa técnico cubeMember → MDX) |
| Vectores de medidas/dimensiones | Pinecone (índice configurado en `PINECONE_INDEX`) |
| Conversaciones y mensajes | SQL Server: `dbo.conversations`, `dbo.messages` |
| Logs de debug | `logs/ask-debug.jsonl`, `logs/chat-debug.jsonl` |

---

## Cómo funciona el pipeline de una pregunta

```
Prompt: "cuantas matriculaciones hay de Ford en 2026"

1. PLANIFICACIÓN
   intents    : ["cuantas matriculaciones hay de Ford en 2026"]
   year       : "2026"
   filter_hints: [{ value: "Ford" }]

2. CANDIDATOS SEMÁNTICOS (Pinecone)
   → top matches por embedding del prompt

3. RANKING DE MÉTRICAS (scoring léxico + semántico)
   → penaliza % / porcentajes si piden absolutos
   → penaliza "diferencia" si piden matriculaciones/ventas
   → boost por entidad (Ford → métricas del Cubo Ford)
   → selecciona: Matriculaciones YTD (Cubo Ford)

4. RESOLUCIÓN DE FILTROS
   → "Ford" coincide con nombre del cubo → implicit_measure_context
   → año 2026 → busca dimensión de fecha en manifest → [Fecha].[Año]

5. MDX GENERADO
   SELECT { [Measures].[Matriculaciones YTD] }
   ON COLUMNS FROM [Cubo Ford]
   WHERE ( [Fecha].[Año].&[2026] )

6. EJECUCIÓN XMLA → msmdpump.dll → SSAS

7. RESPUESTA
   "Matriculaciones YTD es 252873 en 2026."
```

---

## Interfaz de chat

La UI está en `public/chat.html` y se sirve en `GET /chat`.

- Lista de conversaciones persistidas en el panel izquierdo.
- Área de mensajes con historial completo.
- Campo de pregunta y botón de envío.
- Botón "Nueva" para crear conversación.
- El historial se guarda en SQL Server y sobrevive reinicios.

---

## API REST

### `POST /ask`
Pregunta directa sin conversación.

```bash
curl -X POST http://localhost:3002/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "cuantas matriculaciones hay de Ford en 2026"}'
```

Respuesta:
```json
{
  "question": "...",
  "answer": "Matriculaciones YTD es 252873 en 2026.",
  "data": {
    "value": "252873",
    "year": "2026",
    "measure": { "friendly_name": "Matriculaciones YTD", "cube_name": "Cubo_Ford_Cubo_Ford" },
    "mdx": "SELECT ...",
    "plan": { "intents": [...], "filter_hints": [...], "selected_measures": [...] },
    "results": [...]
  }
}
```

### `POST /api/chat/ask`
Pregunta dentro de una conversación persistida.

```bash
curl -X POST http://localhost:3002/api/chat/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "ventas de nissan en 2024", "conversation_id": "<uuid>"}'
```

Si `conversation_id` está vacío, crea una conversación nueva automáticamente.

### `GET /api/chat/conversations`
Lista conversaciones ordenadas por actividad reciente.

### `GET /api/chat/conversations/:id/messages`
Historial completo de una conversación.

### `GET /api/debug/logs`
Logs de trazabilidad estructurados por petición.

```bash
# Últimas 100 entradas del canal ask
curl "http://localhost:3002/api/debug/logs?channel=ask&lines=100"

# Filtrar por traceId específico
curl "http://localhost:3002/api/debug/logs?channel=ask&traceId=<uuid>"

# Canal chat
curl "http://localhost:3002/api/debug/logs?channel=chat&lines=50"
```

Parámetros:
| Parámetro | Valores | Por defecto |
|---|---|---|
| `channel` | `ask` / `chat` | `ask` |
| `lines` | 1–2000 | `200` |
| `traceId` | UUID | (sin filtro) |

---

## Configuración `.env`

```env
# Servidor
PORT=3002
REQUEST_TIMEOUT_MS=30000

# Pinecone (base de datos vectorial para metadata)
PINECONE_API_KEY=pcsk_...
PINECONE_INDEX=cube-metadata-local
PINECONE_NAMESPACE=

# Azure OpenAI (opcional; si no está, usa embeddings locales)
AZURE_OPENAI_ENDPOINT=https://....openai.azure.com/
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small

# Azure AI Projects (opcional, agente alternativo)
AZURE_EXISTING_AGENT_ID=agent-name:1
AZURE_EXISTING_AIPROJECT_ENDPOINT=https://....ai.azure.com/api/projects/...
AZURE_TENANT_ID=...

# SQL Server local (para Cube.dev y persistencia de chat)
DATABASE_URL=sqlserver://localhost:1433;database=chatbot;user=SA;password=...;encrypt=true;trustServerCertificate=true

# SSAS XMLA (para descubrimiento de metadata y ejecución MDX)
XMLA_ENDPOINT=http://192.168.100.50:8080/OLAP/msmdpump.dll
XMLA_USER=dominio\usuario
XMLA_PWD=contraseña

# Cube.dev embebido
CUBEJS_API_SECRET=secreto_local
CUBEJS_PORT=4002
CUBEJS_SCHEMA_PATH=schema
CUBEJS_DEFAULT_SQL_TABLE=dbo.cube_dev_local_bridge
```

---

## Puesta en marcha

### Requisitos

- Node.js 18+
- Acceso VPN a servidor SSAS (`msmdpump.dll`)
- SQL Server local accesible
- Cuenta Pinecone con índice creado (dimensión 1536)

### Primera vez

```bash
# 1. Instalar dependencias
npm install

# 2. Copiar y configurar variables de entorno
cp .env.example .env
# editar .env con credenciales reales

# 3. Descubrir cubos SSAS, generar schemas e indexar en Pinecone
npm run sync-xmla-metadata

# 4. Arrancar el servidor
npm run dev
```

### Uso habitual

```bash
# Arrancar con puerto personalizado (para evitar conflictos)
PORT=3002 CUBEJS_PORT=4002 npm run dev

# Abrir chat en navegador
open http://localhost:3002/chat

# Preguntar por API
curl -X POST http://localhost:3002/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "total mercado 2025"}'
```

### Re-indexar si cambian los cubos

```bash
npm run sync-xmla-metadata
```

---

## Limitaciones actuales

| Situación | Comportamiento |
|---|---|
| Filtro geográfico no encontrado en cubo (ej. `provincia de valencia`) | Error controlado: pide reformular en vez de inventar dato incorrecto |
| Métrica ambigua (mismo nombre en varios cubos) | Toma el primer candidato con mayor score; puede no ser el cubo correcto |
| Azure OpenAI sin configurar | Usa embeddings determinísticos locales (búsqueda semántica degradada pero funcional) |
| Año en formato no soportado por el cubo | Reintenta con formatos alternativos; si todos fallan, devuelve total sin filtro temporal |
| Preguntas fuera del dominio analítico | Intenta encontrar una métrica; si el score es ≤ 0 devuelve error |

---

## Estructura de archivos

```
.
├── public/
│   └── chat.html              # UI de chat
├── schema/
│   ├── *.js                   # Schemas Cube.dev (auto-generados)
│   └── .xmla-manifest.json    # Mapa cubo ↔ MDX (auto-generado)
├── logs/
│   ├── ask-debug.jsonl        # Trazas de peticiones /ask
│   └── chat-debug.jsonl       # Trazas de peticiones de chat
├── src/
│   ├── config/
│   │   └── env.ts             # Variables de entorno
│   ├── controllers/
│   │   ├── askController.ts   # Pipeline principal NL → MDX → respuesta
│   │   ├── chatController.ts  # Conversaciones persistidas
│   │   ├── debugController.ts # Endpoint de logs
│   │   └── queryController.ts # Endpoint alternativo (Cube.dev API)
│   ├── services/
│   │   ├── mdxBridgeService.ts      # Traducción y ejecución MDX
│   │   ├── metadataService.ts       # Pinecone indexing y búsqueda
│   │   ├── xmlaSyncService.ts       # Descubrimiento SSAS y generación schema
│   │   ├── chatPersistenceService.ts# SQL Server: conversations + messages
│   │   ├── sqlServerClient.ts       # Pool SQL Server compartido
│   │   ├── debugLogger.ts           # Logger estructurado JSONL
│   │   ├── azureOpenAIClient.ts     # Embeddings y chat Azure OpenAI
│   │   ├── azureAiProjectsClient.ts # Agente Azure AI Projects
│   │   ├── cubeServer.ts            # Cube.dev embebido
│   │   └── pineconeClient.ts        # Cliente Pinecone
│   ├── scripts/               # Scripts de mantenimiento
│   ├── types/                 # Tipos TypeScript compartidos
│   ├── errors.ts              # Errores personalizados
│   └── index.ts               # Entrada: Express + rutas
├── .env                       # Variables de entorno (no commitear)
├── package.json
└── tsconfig.json
```
