# Frontend NLQ - cambios nuevos (resumen corto)

Documento corto solo con lo nuevo que se agregó para el frontend.

## Reglas de acceso (importante)

- `super_admin` **solo** se usa para administración de reglas:
  - `POST/PATCH/DELETE /api/global-rules`
  - `GET/POST/PATCH/DELETE /api/customer-rules`
  - `GET /api/admin/customers` y `GET /api/admin/customers/:id`
- No requiere `super_admin`: `/auth/me`, `/ask`, `/api/chat/*`, `GET /api/global-rules`.

## Endpoints nuevos

### 1) `GET /api/config` (público)
Sirve para obtener la base real de la API y el `product_id`.

**Response mock**
```json
{
  "api_base_url": "http://localhost:3000",
  "product_id": "354dcab0-c9be-480d-a8df-9efa00c08c84"
}
```

### 2) `GET /auth/me` (auth JWT)
No bloquea por `super_admin`. Devuelve perfil + flags para mostrar UI de reglas.

**Headers**
```http
Authorization: Bearer <JWT>
```

**Response mock**
```json
{
  "user": {
    "id": "9",
    "email": "admin@acme.com",
    "firstName": "Ana",
    "lastName": "Ruiz",
    "username": "ana.ruiz",
    "role": "super_admin",
    "customerId": "124",
    "products": [
      {
        "id": "354dcab0-c9be-480d-a8df-9efa00c08c84",
        "name": "Natural Language Querying"
      }
    ]
  },
  "can_manage_global_rules": true,
  "can_manage_customer_rules": true,
  "canManageRules": true
}
```

Errores típicos: `401` (token inválido/expirado), `503` (`ERR_PROFILE_UNAVAILABLE`).

### 3) Reglas globales

- `GET /api/global-rules` -> lectura para cualquier usuario autenticado.
- `POST /api/global-rules` -> solo `super_admin`.
- `PATCH /api/global-rules/:id` -> solo `super_admin`.
- `DELETE /api/global-rules/:id` -> solo `super_admin`.

**POST body mock**
```json
{
  "name": "Formato de moneda",
  "content": "Responder valores monetarios siempre con separador de miles.",
  "is_active": true,
  "priority": 20
}
```

**Response mock**
```json
{
  "id": 18,
  "name": "Formato de moneda",
  "content": "Responder valores monetarios siempre con separador de miles.",
  "is_active": true,
  "priority": 20,
  "created_at": "2026-04-07T17:45:10.000Z",
  "updated_at": "2026-04-07T17:45:10.000Z"
}
```

### 4) Reglas por cliente (solo `super_admin`)

- `GET /api/customer-rules?customer_id=124&limit=200`
- `POST /api/customer-rules`
- `PATCH /api/customer-rules/:id`
- `DELETE /api/customer-rules/:id`

**POST body mock**
```json
{
  "customer_id": "124",
  "name": "Tono de respuesta",
  "content": "Usar tono ejecutivo y respuestas directas.",
  "is_active": true,
  "priority": 10
}
```

**Response mock**
```json
{
  "id": 42,
  "customer_id": "124",
  "name": "Tono de respuesta",
  "content": "Usar tono ejecutivo y respuestas directas.",
  "is_active": true,
  "priority": 10,
  "created_at": "2026-04-07T17:48:21.000Z",
  "updated_at": "2026-04-07T17:48:21.000Z"
}
```

Nota: al crear regla por cliente, backend valida que el cliente tenga el producto NLQ; si no, responde `403` (`CUSTOMER_NO_NLQ_PRODUCT`).

### 5) Proxy clientes Launcher (solo `super_admin`)
Se usa para selector de cliente en la UI de reglas por cliente.

- `GET /api/admin/customers?query=&page=1&limit=20`
- `GET /api/admin/customers/:id`

**Listado response mock**
```json
{
  "items": [
    {
      "id": "124",
      "name": "Acme Motors",
      "has_nlq_product": true
    },
    {
      "id": "208",
      "name": "Beta Cars",
      "has_nlq_product": false
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 2
}
```

## Sugerencia de uso en front

1. Cargar `GET /auth/me`.
2. Si `canManageRules === false`, ocultar módulo de reglas.
3. Si `true`, habilitar:
   - Reglas globales (CRUD según endpoint).
   - Reglas por cliente (selector con `/api/admin/customers` + CRUD en `/api/customer-rules`).

Referencia completa: `GET /api/docs` (Swagger UI).
