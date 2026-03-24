# Cambios de Backend — Sincronización Frontend

Fecha: Marzo 2026
Versión backend: commit `7ed7add`

---

## Resumen ejecutivo

El endpoint principal `/api/chat/ask` ahora devuelve **3 campos nuevos** en la respuesta:
`answer_html`, `chart_data` y `computed`. El resto de endpoints no cambiaron.

---

## 1. Cambio en la respuesta de `POST /api/chat/ask`

### Antes

```json
{
  "conversation_id": "uuid",
  "question": "dame el total mercado del 2024",
  "answer": "En 2024, el mercado total alcanzó las 1.476.030 matriculaciones...",
  "data": {
    "value": "1476030",
    "cube": "Matriculaciones_Matriculaciones",
    "measure": "Total Mercado",
    "mdx": "SELECT ...",
    "results": [...],
    "selection": {...}
  }
}
```

### Ahora

```json
{
  "conversation_id": "uuid",
  "question": "dame el total mercado del 2024",
  "answer": "En 2024, el mercado total alcanzó las 1.476.030 matriculaciones...",
  "answer_html": "<p>En 2024, el mercado total alcanzó las <strong>1.476.030</strong> matriculaciones...</p>",
  "chart_data": null,
  "computed": null,
  "data": {
    "value": "1476030",
    "cube": "Matriculaciones_Matriculaciones",
    "measure": "Total Mercado",
    "mdx": "SELECT ...",
    "results": [...],
    "selection": {...}
  }
}
```

### Ejemplo con tabla y chart (desglose por años)

Pregunta: _"dame un listado del total mercado por años"_

```json
{
  "conversation_id": "uuid",
  "question": "dame un listado del total mercado por años",
  "answer": "Aquí tienes el histórico año a año:\n\nAño         Total Mercado\n----------  -------------\n2020        1.224.812\n2021        1.305.584\n2022        1.458.679\n2023        1.476.030\n2024        1.645.508",
  "answer_html": "<p>Aquí tienes el histórico año a año:</p><table><thead><tr><th>Año</th><th>Total Mercado</th></tr></thead><tbody><tr><td>2020</td><td><strong>1.224.812</strong></td></tr><tr><td>2021</td><td>1.305.584</td></tr></tbody></table><p>El mercado ha crecido un 34% desde 2020...</p>",
  "chart_data": {
    "type": "line",
    "labels": ["2020", "2021", "2022", "2023", "2024"],
    "datasets": [
      {
        "label": "Total Mercado",
        "data": [1224812, 1305584, 1458679, 1476030, 1645508]
      }
    ]
  },
  "computed": {
    "sum": 7110613,
    "avg": 1422122,
    "max": 1645508,
    "min": 1224812,
    "count": 5,
    "label": "Total Mercado"
  },
  "data": { ... }
}
```

---

## 2. Lógica de renderizado recomendada

```javascript
function renderAssistantMessage(payload) {
  // 1. Mostrar el texto principal (HTML si está disponible, texto plano como fallback)
  const messageText = payload.answer_html
    ? DOMPurify.sanitize(payload.answer_html)
    : escapeHtml(payload.answer);

  // 2. Mostrar totales calculados si existen
  const computedBlock = payload.computed && payload.computed.count > 1
    ? renderComputed(payload.computed)
    : '';

  // 3. Mostrar gráfico si existe
  const chartBlock = payload.chart_data
    ? renderChart(payload.chart_data)
    : '';

  return `
    <div class="chat-message assistant">
      <div class="chat-response">${messageText}</div>
      ${computedBlock}
      ${chartBlock}
    </div>
  `;
}

function renderComputed(computed) {
  return `
    <div class="computed-summary">
      <span>Total: <strong>${computed.sum.toLocaleString('es-ES')}</strong></span>
      <span>Promedio: ${computed.avg.toLocaleString('es-ES')}</span>
      <span>Máx: ${computed.max.toLocaleString('es-ES')}</span>
      <span>Mín: ${computed.min.toLocaleString('es-ES')}</span>
    </div>
  `;
}

function renderChart(chartData) {
  const canvasId = 'chart-' + Date.now();
  // Renderizar después de insertar en el DOM
  requestAnimationFrame(() => {
    const ctx = document.getElementById(canvasId).getContext('2d');
    new Chart(ctx, {
      type: chartData.type,
      data: {
        labels: chartData.labels,
        datasets: chartData.datasets.map(ds => ({
          label: ds.label,
          data: ds.data,
          borderWidth: 2,
          fill: false
        }))
      },
      options: {
        responsive: true,
        plugins: { legend: { display: chartData.datasets.length > 1 } }
      }
    });
  });
  return `<canvas id="${canvasId}" class="chart-canvas"></canvas>`;
}
```

---

## 3. Dependencias a instalar

### DOMPurify (sanitización de HTML)

```bash
npm install dompurify
# o desde CDN:
# <script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
```

### Chart.js (gráficos)

```bash
npm install chart.js
# o desde CDN:
# <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
```

---

## 4. CSS necesario para las tablas HTML

El backend no envía clases ni estilos en el HTML. El frontend debe estilizar los tags directamente dentro del contenedor `.chat-response`:

```css
/* Tablas */
.chat-response table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.75rem 0;
  font-size: 0.9rem;
}

.chat-response th,
.chat-response td {
  padding: 7px 14px;
  border: 1px solid #e0e0e0;
  text-align: left;
  white-space: nowrap;
}

.chat-response thead tr {
  background-color: #f5f5f5;
  font-weight: 600;
}

.chat-response tbody tr:nth-child(even) {
  background-color: #fafafa;
}

/* Listas */
.chat-response ul,
.chat-response ol {
  padding-left: 1.4rem;
  margin: 0.5rem 0;
}

.chat-response li {
  margin-bottom: 0.3rem;
}

/* Énfasis */
.chat-response strong {
  font-weight: 600;
}

/* Párrafos */
.chat-response p {
  margin: 0.5rem 0;
}

/* Gráficos */
.chart-canvas {
  max-height: 320px;
  margin-top: 1rem;
}

/* Resumen de totales */
.computed-summary {
  display: flex;
  gap: 1.5rem;
  margin-top: 0.75rem;
  font-size: 0.85rem;
  color: #666;
}
```

---

## 5. Tags HTML que puede contener `answer_html`

Solo estos tags aparecerán en `answer_html`. Ninguno lleva atributos `class`, `style`, `href` ni eventos.

| Tag | Uso |
|---|---|
| `<p>` | Párrafos de texto |
| `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>`, `<td>` | Tablas de datos |
| `<ul>`, `<ol>`, `<li>` | Listas |
| `<strong>`, `<em>` | Énfasis de texto |
| `<br>` | Salto de línea |

---

## 6. Cuándo aparece cada campo

| Campo | Valor `null` cuando... | Valor distinto de `null` cuando... |
|---|---|---|
| `answer_html` | Respuesta simple de texto, sin datos estructurados | La respuesta incluye tabla, lista o texto con énfasis |
| `chart_data` | Resultado escalar (un solo valor) | Hay 2 o más filas con etiqueta + valor numérico |
| `computed` | Resultado escalar o sin valores numéricos | Hay 2 o más resultados numéricos |

---

## 7. Request sin cambios

El body del request no cambia. No hace falta enviar ningún parámetro nuevo:

```json
{
  "conversation_id": "uuid-opcional",
  "question": "dame el total mercado de 2024 y 2025"
}
```

El backend detecta automáticamente si es una consulta de valor único, multi-año o desglose.

---

## 8. Autenticación sin cambios

El header `Authorization: Bearer <token>` sigue igual. Los cubos que cada usuario puede ver los gestiona el backend; el frontend no necesita cambiar nada relacionado con permisos.

---

## 9. Endpoints que NO cambiaron

Estos endpoints mantienen exactamente el mismo contrato que antes:

- `GET /api/chat/conversations`
- `POST /api/chat/conversations`
- `DELETE /api/chat/conversations/:id`
- `GET /api/chat/conversations/:id/messages`
- `GET /api/global-rules`
- `POST /api/global-rules`
- `PATCH /api/global-rules/:id`
- `DELETE /api/global-rules/:id`
- `GET /api/docs` (Swagger UI)
