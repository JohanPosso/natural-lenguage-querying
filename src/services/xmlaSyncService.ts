/**
 * XmlaSyncService — capa de comunicación con SSAS vía protocolo XMLA.
 *
 * Responsabilidades:
 *   - Enviar peticiones DISCOVER al endpoint XMLA (DBSCHEMA_CATALOGS,
 *     MDSCHEMA_CUBES, MDSCHEMA_MEASURES, MDSCHEMA_DIMENSIONS, MDSCHEMA_HIERARCHIES...)
 *   - Exponer discoverRows() para que catalogService pueda poblar las tablas SQL
 *
 * Lo que ya NO hace este servicio:
 *   - Escribir .xmla-manifest.json
 *   - Generar archivos schema/*.js de Cube.js
 *   - Mantener caché in-memory
 */

import axios, { AxiosInstance } from "axios";
import { parseStringPromise, processors } from "xml2js";
import { env } from "../config/env";

type XmlaRow = Record<string, string>;

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class XmlaSyncService {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: env.requestTimeoutMs,
      headers: { "Content-Type": "text/xml; charset=utf-8" }
    });
  }

  private ensureConfigured(): void {
    const missing = [
      ["XMLA_ENDPOINT", env.xmlaEndpoint],
      ["XMLA_USER", env.xmlaUser],
      ["XMLA_PWD", env.xmlaPassword]
    ]
      .filter(([, v]) => !v)
      .map(([name]) => name);

    if (missing.length) {
      throw new Error(`Faltan credenciales XMLA: ${missing.join(", ")}`);
    }
  }

  private buildDiscoverEnvelope(
    requestType: string,
    restrictions?: Record<string, string>,
    catalog?: string
  ): string {
    const restrictionXml = Object.entries(restrictions ?? {})
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join("");
    const effectiveCatalog = catalog ?? env.xmlaCatalog;
    const catalogXml = effectiveCatalog
      ? `<Catalog>${escapeXml(effectiveCatalog)}</Catalog>`
      : "";

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

  private async parseRows(xml: string): Promise<XmlaRow[]> {
    const parsed = (await parseStringPromise(xml, {
      explicitArray: false,
      tagNameProcessors: [processors.stripPrefix]
    })) as Record<string, any>;

    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throw new Error(`XMLA fault: ${JSON.stringify(fault)}`);

    const rows =
      parsed?.Envelope?.Body?.DiscoverResponse?.return?.root?.row ??
      parsed?.Envelope?.Body?.DiscoverResponse?.return?.row;

    return toArray(rows).map((row) => {
      const out: XmlaRow = {};
      Object.entries(row ?? {}).forEach(([k, v]) => {
        out[k] = String(v ?? "");
      });
      return out;
    });
  }

  /**
   * Ejecuta un DISCOVER XMLA y devuelve las filas resultantes.
   * Es la función central que consume catalogService para sincronizar el catálogo.
   */
  async discoverRows(
    requestType: string,
    restrictions?: Record<string, string>,
    catalog?: string
  ): Promise<XmlaRow[]> {
    this.ensureConfigured();
    try {
      const envelope = this.buildDiscoverEnvelope(requestType, restrictions, catalog);
      const response = await this.http.post(
        env.xmlaEndpoint,
        envelope,
        { auth: { username: env.xmlaUser, password: env.xmlaPassword } }
      );
      return this.parseRows(response.data);
    } catch (error) {
      if (axios.isAxiosError(error) && error.code === "ECONNABORTED") {
        throw new Error("Timeout XMLA (posible problema de VPN/red).");
      }
      throw new Error(`XMLA discover falló (${requestType}): ${(error as Error).message}`);
    }
  }
}

export const xmlaSyncService = new XmlaSyncService();
