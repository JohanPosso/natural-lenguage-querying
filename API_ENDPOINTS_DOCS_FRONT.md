# Endpoints para Frontend (natural-lenguage-queryng)

## Base URL
- `http://<host>:3000` (según `PORT` en `.env`)

## Autenticación (AUTH)
Los endpoints marcados como **PROTEGIDOS** usan `authMiddleware` y validan permisos contra el **API Launcher**.

Header requerido en PROTEGIDOS:
- `Authorization: Bearer <token>`

Qué hace el backend al recibir el token:
1. Decodifica el JWT localmente para obtener `userId`
2. Llama al API Launcher para obtener permisos de acceso del usuario al `PRODUCT_ID`
3. Restringe qué `allowedCubes` puede ver el usuario

Variables relevantes:
- `API_LAUNCHER_ENDPOINT`
- `PRODUCT_ID`
- `BYPASS_AUTH` (si `true`, omite autenticación para desarrollo)

## Endpoints públicos (SIN AUTH)

### Health check
`GET /health`

Mock response:
```json
{
  "ok": true,
  "timestamp": "2026-03-23T12:34:56.789Z"
}
```

### UI de chat (estática)
`GET /chat`
- Sirve `public/chat.html`

### Debug (sin auth)
Estos endpoints existen para monitoreo; pueden usarse desde el servidor o herramientas internas.

`GET /api/debug/logs`
- Query params opcionales:
  - `channel` (default: `ask`; acepta `ask` o `chat`)
  - `lines` (default: `200`)
  - `traceId` (opcional: filtra por traceId)

Mock response:
```json
{
  "channel": "ask",
  "lines": 2,
  "logs": [
    "{\"event\":\"pipeline_start\",\"traceId\":\"abc\"}",
    "{\"event\":\"pipeline_success\",\"traceId\":\"abc\",\"elapsed_ms\":14200}"
  ]
}
```

`GET /api/debug/summary`
- Query params opcionales:
  - `limit` (default: `20`, max `100`)

Mock response:
```json
{
  "total": 1,
  "queries": [
    {
      "traceId": "abc",
      "ts": "2026-03-23T12:34:56.789Z",
      "status": "ok",
      "question": "cuántas matriculaciones hubo en 2024",
      "elapsed_ms": 14200,
      "cube": "Matriculaciones_Matriculaciones",
      "measures": ["Total Mercado"],
      "filters_requested": ["Año=2024"],
      "filters_resolved": [
        {
          "hierarchy": "[Fecha].[Año]",
          "value": "2024",
          "resolved": true
        }
      ],
      "filters_not_found": [],
      "mdx_queries": [
        {
          "status": "ok",
          "measure": "Total Mercado",
          "label": "Año=\"2024\"",
          "value": "1476030",
          "mdx": "SELECT ...",
          "error": null
        }
      ],
      "answer": "En 2024 ...",
      "error": null
    }
  ]
}
```

## Endpoints protegidos (CON AUTH)
Todos requieren `Authorization: Bearer <token>` salvo que `BYPASS_AUTH=true`.

### Ejecutar pregunta (sin conversación persistida)
`POST /ask`

Body (JSON):
- `question` (string) o `user_prompt` (string)

Mock request:
```json
{ "question": "cuántas matriculaciones hubo en 2024" }
```

Mock response (ver sección `AskResponsePayload`).

### Conversaciones (persistencia)

`GET /api/chat/conversations`

Mock response:
```json
{
  "conversations": [
    {
      "id": "798d841d-138a-414b-aad6-e2a5aad09749",
      "title": "Pruebas..."
    }
  ]
}
```

`POST /api/chat/conversations`

Body (JSON):
- `title` (string, opcional)

Mock request:
```json
{ "title": "Pruebas de coherencia" }
```

Mock response:
```json
{
  "conversation": {
    "id": "798d841d-138a-414b-aad6-e2a5aad09749",
    "title": "Pruebas de coherencia"
  }
}
```

`DELETE /api/chat/conversations/:id`
- `:id` = `conversation_id`

Mock response:
```json
{
  "ok": true,
  "id": "798d841d-138a-414b-aad6-e2a5aad09749"
}
```

Errores:
- `404`:
```json
{ "error": "Conversation not found." }
```

`GET /api/chat/conversations/:id/messages`
- `:id` = `conversation_id`

Mock response:
```json
{
  "messages": [
    {
      "role": "user",
      "content": "cuántas matriculaciones hubo en 2024",
      "created_at": "2026-03-23T12:34:56.789Z"
    },
    {
      "role": "assistant",
      "content": "En 2024, ...",
      "created_at": "2026-03-23T12:34:59.001Z"
    }
  ]
}
```

## Reglas globales (CRUD)
Tabla gestionada por backend: `dbo.global_rules`

Campos:
- `id` (UUID)
- `name` (string)
- `content` (string largo)
- `is_active` (boolean)
- `priority` (number; menor = más prioridad)
- `created_at`, `updated_at`

### Listar reglas
`GET /api/global-rules`
- Query opcional: `limit` (default: 200)

Mock response:
```json
{
  "rules": [
    {
      "id": "d9f3f6f0-b0fb-4f33-b8df-6f8c30d8c29a",
      "name": "No inventar filtros",
      "content": "Nunca crear filtros no mencionados por el usuario.",
      "is_active": true,
      "priority": 10,
      "created_at": "2026-03-23T11:00:00.000Z",
      "updated_at": "2026-03-23T11:00:00.000Z"
    }
  ]
}
```

### Crear regla
`POST /api/global-rules`

Body:
```json
{
  "name": "Responder en español",
  "content": "Responder siempre en español al usuario final.",
  "is_active": true,
  "priority": 20
}
```

Mock response:
```json
{
  "rule": {
    "id": "49b555f8-36e6-4be2-9476-e4cc3ccf7a1e",
    "name": "Responder en español",
    "content": "Responder siempre en español al usuario final.",
    "is_active": true,
    "priority": 20,
    "created_at": "2026-03-23T11:10:00.000Z",
    "updated_at": "2026-03-23T11:10:00.000Z"
  }
}
```

### Actualizar regla
`PATCH /api/global-rules/:id`

Body parcial (al menos uno):
- `name`
- `content`
- `is_active`
- `priority`

Ejemplo request:
```json
{
  "is_active": false,
  "priority": 80
}
```

Mock response:
```json
{
  "rule": {
    "id": "49b555f8-36e6-4be2-9476-e4cc3ccf7a1e",
    "name": "Responder en español",
    "content": "Responder siempre en español al usuario final.",
    "is_active": false,
    "priority": 80,
    "created_at": "2026-03-23T11:10:00.000Z",
    "updated_at": "2026-03-23T11:12:00.000Z"
  }
}
```

### Eliminar regla
`DELETE /api/global-rules/:id`

Mock response:
```json
{
  "ok": true,
  "id": "49b555f8-36e6-4be2-9476-e4cc3ccf7a1e"
}
```

Errores:
- `404`:
```json
{ "error": "Rule not found." }
```

### Preguntar en una conversación (ENDPOINT PRINCIPAL del front)
`POST /api/chat/ask`

Body (JSON):
- `conversation_id` (string, opcional). Si no se envía o está vacío, el backend crea conversación.
- `question` (string) o `user_prompt` (string)

Mock request (con conversación):
```json
{
  "conversation_id": "798d841d-138a-414b-aad6-e2a5aad09749",
  "question": "cuántas matriculaciones hubo en 2024"
}
```

Mock request (sin conversación_id):
```json
{ "question": "cuántas matriculaciones hubo en 2024" }
```

Mock response:
```json
{
  "conversation_id": "798d841d-138a-414b-aad6-e2a5aad09749",
  "question": "cuántas matriculaciones hubo en 2024",
  "answer": "En 2024, el total ...",
  "data": {
    "value": "1476030",
    "cube": "Matriculaciones_Matriculaciones",
    "measure": "Total Mercado",
    "mdx": "SELECT { [Measures].[Total Mercado] } ON COLUMNS FROM [Matriculaciones_Matriculaciones] WHERE ( [Fecha].[Año].&[2024] )",
    "results": [
      {
        "technical_name": "Matriculaciones_Matriculaciones.measuresTotalMercado",
        "friendly_name": "Total Mercado",
        "cube_name": "Matriculaciones_Matriculaciones",
        "mdx": "SELECT ...",
        "value": "1476030",
        "catalog": "Matriculaciones",
        "filter_combo": [
          {
            "dimension_friendly": "Año",
            "dimension_mdx": "[Fecha].[Año]",
            "value_caption": "2024",
            "member_unique_name": "[Fecha].[Año].&[2024]"
          }
        ],
        "filter_label": "Año=\"2024\""
      }
    ],
    "selection": {
      "cube_name": "Matriculaciones_Matriculaciones",
      "measures": [
        {
          "technical_name": "Matriculaciones_Matriculaciones.measuresTotalMercado",
          "friendly_name": "Total Mercado",
          "mdx_unique_name": "[Measures].[Total Mercado]"
        }
      ],
      "filters": [
        {
          "type": "year",
          "hierarchy_mdx": "[Fecha].[Año]",
          "friendly_name": "Año",
          "values": ["2024"]
        }
      ]
    }
  }
}
```

## AskResponsePayload (estructura común)
Se devuelve tanto por `POST /ask` como por `POST /api/chat/ask`.

Mock:
```json
{
  "question": "string",
  "answer": "string",
  "data": {
    "value": "string | null",
    "cube": "string | null",
    "measure": "string | null",
    "mdx": "string | null",
    "results": [
      {
        "technical_name": "string",
        "friendly_name": "string",
        "cube_name": "string",
        "mdx": "string",
        "value": "string | null",
        "catalog": "string",
        "filter_combo": [
          {
            "dimension_friendly": "string",
            "dimension_mdx": "string",
            "value_caption": "string",
            "member_unique_name": "string"
          }
        ],
        "filter_label": "string"
      }
    ],
    "selection": {
      "cube_name": "string",
      "measures": [],
      "filters": []
    }
  }
}
```

## Notas para el Front
- El front actual (`public/chat.html`) usa:
  - `GET /api/chat/conversations`
  - `GET /api/chat/conversations/:id/messages`
  - `POST /api/chat/conversations`
  - `POST /api/chat/ask`
- No existe endpoint `chat/stream` en este repo.
