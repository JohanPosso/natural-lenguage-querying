/**
 * Límites de payload y presentación para respuestas con muchos registros.
 * Evita cargar JSON/HTML enormes en el cliente y en el LLM formateador.
 */
export const RESPONSE_MAX_ROWS = 100;
/** Máximo de dimensiones (pares en filter_combo) por fila en la respuesta */
export const RESPONSE_MAX_DIMENSION_COLUMNS = 100;
