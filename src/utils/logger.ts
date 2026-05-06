import "dotenv/config";

import { AgesLog } from "se_configbase";

export function log(message: string): void {
  AgesLog.log(message);
}

export function warn(message: string): void {
  AgesLog.warn(message);
}

export function error(message: string): void {
  AgesLog.error(message);
}

export function isConfigEnabled(name: string): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes((process.env[name] ?? "").trim().toLowerCase());
}
