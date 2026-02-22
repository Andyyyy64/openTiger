// Determine whether system-level operations are permitted
export function canControlSystem(method: string): boolean {
  if (method === "api-key" || method === "bearer") {
    return true;
  }
  // Allow explicit disabling as a safety valve for local operation
  return process.env.OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL !== "false";
}
