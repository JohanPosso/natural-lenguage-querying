export class NoRelevantMetadataError extends Error {
  constructor(message = "No relevant metadata found for user query.") {
    super(message);
    this.name = "NoRelevantMetadataError";
  }
}

export class InvalidLlmJsonError extends Error {
  constructor(message = "LLM returned invalid JSON query format.") {
    super(message);
    this.name = "InvalidLlmJsonError";
  }
}
