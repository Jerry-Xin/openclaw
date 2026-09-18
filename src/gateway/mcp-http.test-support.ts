// Pure JSON-schema builders shared with mcp-http.test.ts, split out to keep that
// grandfathered test file within its line cap.
export function objectSchema(properties: Record<string, unknown>, required?: string[]) {
  return {
    type: "object",
    properties,
    ...(required ? { required } : {}),
  };
}

export function angleSchema(property: unknown, required: string[] = []) {
  return objectSchema({ angle: property }, required);
}
