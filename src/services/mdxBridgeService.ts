/**
 * MdxBridgeService — ejecución MDX y resolución de miembros vía XMLA.
 *
 * Responsabilidades:
 *   - Ejecutar consultas MDX contra SSAS (executeMdx)
 *   - Resolver valores de filtro a unique names SSAS (findBestMemberByCaption)
 *     con un caché liviano por proceso para evitar llamadas repetidas en la misma sesión
 *
 * Lo que ya NO hace este servicio:
 *   - Leer el manifiesto JSON (lo hace catalogService desde SQL)
 *   - Cachear jerarquías en memoria (viven en dbo.olap_hierarchies)
 */

import axios from "axios";
import { parseStringPromise, processors } from "xml2js";
import { env } from "../config/env";

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

class MdxBridgeService {
  /**
   * Caché liviano de miembros SSAS para la sesión del proceso.
   * Solo se usa para findBestMemberByCaption (MDSCHEMA_MEMBERS).
   * Las jerarquías ya no se cachean aquí — viven en SQL vía catalogService.
   */
  private memberCache = new Map<string, Array<Record<string, string>>>();

  // -- XMLA internals ----------------------------------------------------------

  private executeEnvelope(mdx: string, catalog: string): string {
    return [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">`,
      `<soap:Body>`,
      `<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">`,
      `<Command><Statement><![CDATA[${mdx}]]></Statement></Command>`,
      `<Properties><PropertyList>`,
      `<Catalog>${catalog}</Catalog>`,
      `<Format>Tabular</Format>`,
      `<Content>Data</Content>`,
      `</PropertyList></Properties>`,
      `</Execute>`,
      `</soap:Body>`,
      `</soap:Envelope>`
    ].join("");
  }

  private discoverEnvelope(
    requestType: string,
    restrictions: Record<string, string>,
    catalog?: string
  ): string {
    const restrictionXml = Object.entries(restrictions)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join("");
    const catalogXml = catalog ? `<Catalog>${catalog}</Catalog>` : "";

    return [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">`,
      `<soap:Body>`,
      `<Discover xmlns="urn:schemas-microsoft-com:xml-analysis">`,
      `<RequestType>${requestType}</RequestType>`,
      `<Restrictions><RestrictionList>${restrictionXml}</RestrictionList></Restrictions>`,
      `<Properties><PropertyList>${catalogXml}<Format>Tabular</Format><Content>SchemaData</Content></PropertyList></Properties>`,
      `</Discover>`,
      `</soap:Body>`,
      `</soap:Envelope>`
    ].join("");
  }

  private async discoverRows(
    requestType: string,
    restrictions: Record<string, string>,
    catalog?: string
  ): Promise<Array<Record<string, string>>> {
    if (!env.xmlaEndpoint || !env.xmlaUser || !env.xmlaPassword) {
      throw new Error("Faltan credenciales XMLA para el discover.");
    }

    const cacheKey = JSON.stringify({ requestType, restrictions, catalog: catalog ?? "" });
    const cached = this.memberCache.get(cacheKey);
    if (cached) return cached;

    const response = await axios.post(
      env.xmlaEndpoint,
      this.discoverEnvelope(requestType, restrictions, catalog),
      {
        auth: { username: env.xmlaUser, password: env.xmlaPassword },
        headers: { "Content-Type": "text/xml; charset=utf-8" },
        timeout: env.requestTimeoutMs
      }
    );

    const parsed = (await parseStringPromise(response.data, {
      explicitArray: false,
      tagNameProcessors: [processors.stripPrefix]
    })) as Record<string, any>;

    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throw new Error(`XMLA Discover fault: ${JSON.stringify(fault)}`);

    const rootRows = parsed?.Envelope?.Body?.DiscoverResponse?.return?.root?.row;
    const rows = toArray(rootRows).map((row) => {
      const out: Record<string, string> = {};
      Object.entries(row ?? {}).forEach(([k, v]) => { out[k] = String(v ?? ""); });
      return out;
    });

    this.memberCache.set(cacheKey, rows);
    return rows;
  }

  // -- API pública -------------------------------------------------------------

  /** Normaliza un string para comparación: elimina acentos, minúsculas, trim */
  private norm(s: string): string {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }

  /**
   * Busca el MEMBER_UNIQUE_NAME exacto en SSAS para un valor dado.
   * Estrategia de scoring:
   *   20 pts — match exacto
   *   10 pts — caption contiene el término buscado
   *    8 pts — caption empieza por el término (útil para singulares: "Moto" -> "Moto Carretera")
   *    6 pts — término contiene la caption (mínimo 3 chars para evitar falsos positivos)
   */
  async findBestMemberByCaption(
    catalog: string,
    cubeName: string,
    hierarchyUniqueName: string,
    rawValue: string
  ): Promise<{ caption: string; uniqueName: string } | null> {
    const rows = await this.discoverRows(
      "MDSCHEMA_MEMBERS",
      { CUBE_NAME: cubeName, HIERARCHY_UNIQUE_NAME: hierarchyUniqueName },
      catalog
    );

    const normalized = this.norm(rawValue);
    if (!normalized) return null;

    let best: { caption: string; uniqueName: string; score: number } | null = null;

    for (const row of rows) {
      const caption = row.MEMBER_CAPTION ?? row.MEMBER_NAME ?? "";
      const uniqueName = row.MEMBER_UNIQUE_NAME ?? "";
      if (!caption || !uniqueName) continue;

      const captionNorm = this.norm(caption);

      let score = 0;
      if (captionNorm === normalized) score += 20;
      if (captionNorm.includes(normalized)) score += 10;
      if (captionNorm.startsWith(normalized) && normalized.length >= 3) score += 8;
      if (normalized.includes(captionNorm) && captionNorm.length >= 3) score += 6;

      if (!best || score > best.score) {
        best = { caption, uniqueName, score };
      }
    }

    return best && best.score > 0
      ? { caption: best.caption, uniqueName: best.uniqueName }
      : null;
  }

  /**
   * Busca TODOS los miembros cuya caption empieza por el prefijo dado.
   * Útil para términos en plural/genérico: "motos" -> ["Moto Carretera", "Moto Campo", "Moto Scooter"].
   * El prefijo se deduce strippeando la 's' final si el término no encontró match exacto.
   */
  async findMembersWithPrefix(
    catalog: string,
    cubeName: string,
    hierarchyUniqueName: string,
    rawValue: string
  ): Promise<Array<{ caption: string; uniqueName: string }>> {
    const rows = await this.discoverRows(
      "MDSCHEMA_MEMBERS",
      { CUBE_NAME: cubeName, HIERARCHY_UNIQUE_NAME: hierarchyUniqueName },
      catalog
    );

    const normalized = this.norm(rawValue);
    const singular = normalized.endsWith("s") && normalized.length > 3
      ? normalized.slice(0, -1)
      : normalized;

    const prefixesToTry = Array.from(new Set([normalized, singular]));
    const found: Array<{ caption: string; uniqueName: string }> = [];

    for (const row of rows) {
      const caption = row.MEMBER_CAPTION ?? row.MEMBER_NAME ?? "";
      const uniqueName = row.MEMBER_UNIQUE_NAME ?? "";
      if (!caption || !uniqueName) continue;

      const captionNorm = this.norm(caption);
      if (prefixesToTry.some((p) => captionNorm.startsWith(p) && p.length >= 3)) {
        found.push({ caption, uniqueName });
      }
    }

    return found;
  }

  /**
   * Busca TODOS los miembros cuya caption CONTIENE el término dado.
   * Útil para términos que son sufijos de categoría: "SUV" -> ASUV, BSUV, CSUV, etc.
   * Solo se activa cuando el término tiene al menos 3 caracteres.
   *
   * @returns Array de miembros encontrados, sin duplicados
   */
  async findMembersContaining(
    catalog: string,
    cubeName: string,
    hierarchyUniqueName: string,
    rawValue: string
  ): Promise<Array<{ caption: string; uniqueName: string }>> {
    const rows = await this.discoverRows(
      "MDSCHEMA_MEMBERS",
      { CUBE_NAME: cubeName, HIERARCHY_UNIQUE_NAME: hierarchyUniqueName },
      catalog
    );

    const normalized = this.norm(rawValue);
    if (normalized.length < 3) return [];

    const found: Array<{ caption: string; uniqueName: string }> = [];

    for (const row of rows) {
      const caption = row.MEMBER_CAPTION ?? row.MEMBER_NAME ?? "";
      const uniqueName = row.MEMBER_UNIQUE_NAME ?? "";
      if (!caption || !uniqueName) continue;

      const captionNorm = this.norm(caption);
      if (captionNorm.includes(normalized)) {
        found.push({ caption, uniqueName });
      }
    }

    return found;
  }

  /**
   * Ejecuta una consulta MDX contra SSAS y devuelve las filas de resultado.
   */
  async executeMdx(mdx: string, catalog: string): Promise<Record<string, unknown>> {
    if (!env.xmlaEndpoint || !env.xmlaUser || !env.xmlaPassword) {
      throw new Error("Faltan credenciales XMLA para ejecutar MDX.");
    }

    const response = await axios.post(
      env.xmlaEndpoint,
      this.executeEnvelope(mdx, catalog),
      {
        auth: { username: env.xmlaUser, password: env.xmlaPassword },
        headers: { "Content-Type": "text/xml; charset=utf-8" },
        timeout: env.requestTimeoutMs
      }
    );

    const parsed = (await parseStringPromise(response.data, {
      explicitArray: false,
      tagNameProcessors: [processors.stripPrefix]
    })) as Record<string, any>;

    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throw new Error(`XMLA Execute fault: ${JSON.stringify(fault)}`);

    const rootRows =
      parsed?.Envelope?.Body?.ExecuteResponse?.return?.root?.row ??
      parsed?.Envelope?.Body?.ExecuteResponse?.return?.root?.CellData?.Cell;

    return { mdx, catalog, rows: toArray(rootRows) };
  }
}

export const mdxBridgeService = new MdxBridgeService();
