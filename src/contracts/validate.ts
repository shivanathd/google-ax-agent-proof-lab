// Loads the JSON Schemas in ./schemas and returns a typed assert function per contract.
// Validation failure throws with a sanitized list of schema paths; values are never echoed.
import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
const cache = new Map<string, ValidateFunction>();

export class ContractError extends Error {
  constructor(public contract: string, public issues: string[]) {
    super(`${contract} invalid: ${issues.join("; ")}`);
  }
}

export function validator(name: string): ValidateFunction {
  let fn = cache.get(name);
  if (!fn) {
    const schema = JSON.parse(readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url), "utf8"));
    fn = ajv.compile(schema);
    cache.set(name, fn);
  }
  return fn;
}

export function assertContract<T>(name: string, value: unknown): T {
  const fn = validator(name);
  if (!fn(value)) {
    throw new ContractError(name, (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`));
  }
  return value as T;
}
