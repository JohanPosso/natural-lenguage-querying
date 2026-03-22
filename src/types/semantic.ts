export type CubeFieldKind = "measure" | "dimension";

export interface CubeMember {
  technicalName: string;
  cubeName: string;
  shortName: string;
  title?: string;
  description?: string;
  dataType?: string;
  kind: CubeFieldKind;
}

export interface CubeApiMetaResponse {
  cubes: Array<{
    name: string;
    measures?: Array<{
      name: string;
      title?: string;
      shortTitle?: string;
      description?: string;
      type?: string;
    }>;
    dimensions?: Array<{
      name: string;
      title?: string;
      shortTitle?: string;
      description?: string;
      type?: string;
    }>;
  }>;
}

export interface CubeLoadQuery {
  measures?: string[];
  dimensions?: string[];
  timeDimensions?: Array<{
    dimension: string;
    granularity?: string;
    dateRange?: string | [string, string];
  }>;
  filters?: Array<{
    member?: string;
    dimension?: string;
    operator: string;
    values?: string[];
  }>;
  order?: Record<string, "asc" | "desc">;
  limit?: number;
  offset?: number;
}

export interface CubeLoadResponse<T = Record<string, unknown>> {
  query: CubeLoadQuery;
  data: T[];
  annotation?: Record<string, unknown>;
  lastRefreshTime?: string;
}

export interface OrchestrationResult<T = Record<string, unknown>> {
  generatedQuery: CubeLoadQuery;
  selectedTechnicalElements: string[];
  cubeResponse: CubeLoadResponse<T>;
  summary: string;
}
