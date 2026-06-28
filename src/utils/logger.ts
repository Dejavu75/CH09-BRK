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

export async function sendDebugMail(subject: string, text: string): Promise<void> {
  try {
    const result = await AgesLog.sendMailDebug(subject, text, "", "");
    AgesLog.log(`mail debug ok | subject=${subject} | result=${result}`);
  } catch (mailError) {
    AgesLog.warn(`mail debug fail | subject=${subject} | err=${mailError instanceof Error ? mailError.message : String(mailError)}`);
  }
}

export function isConfigEnabled(name: string): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes((process.env[name] ?? "").trim().toLowerCase());
}
