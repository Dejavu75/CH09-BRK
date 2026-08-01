import { BROKER_BUILD_INFO } from "../generated/build_info";

type Environment = NodeJS.ProcessEnv;
type JsonObject = Record<string, unknown>;

export function configureHeartbeatExtraData(environment: Environment = process.env): string {
  const extraData = buildHeartbeatExtraData(environment.MSEXTRADATA, environment);
  environment.MSEXTRADATA = extraData;
  return extraData;
}

export function buildHeartbeatExtraData(existingExtraData: string | undefined, environment: Environment): string {
  const existing = parseExtraData(existingExtraData);
  const codeOwnedKeys = new Set(["component", "associatedSystem", "associatedInstance", "build"]);
  const sortedExisting = Object.fromEntries(
    Object.entries(existing)
      .filter(([key]) => !codeOwnedKeys.has(key))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  );

  return JSON.stringify({
    ...sortedExisting,
    component: "ch09-broker",
    associatedSystem: getEnvironmentValue(environment.MSASSOCIATEDSYSTEM),
    associatedInstance: getEnvironmentValue(environment.MSASSOCIATEDINSTANCE) || getEnvironmentValue(environment.MSINSTANCE),
    build: {
      version: BROKER_BUILD_INFO.version,
      builtAt: BROKER_BUILD_INFO.builtAt,
      buildNumber: BROKER_BUILD_INFO.buildNumber,
      gitSha: BROKER_BUILD_INFO.gitSha,
      gitDirty: BROKER_BUILD_INFO.gitDirty
    }
  });
}

function parseExtraData(value: string | undefined): JsonObject {
  if (!value) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getEnvironmentValue(value: string | undefined): string {
  return value?.trim() ?? "";
}
