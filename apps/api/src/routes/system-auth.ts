// system系の操作が許可されているか判定する
export function canControlSystem(method: string): boolean {
  if (method === "api-key" || method === "bearer") {
    return true;
  }
  // Explicit safety valve for local/dev-only operation
  return process.env.OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL === "true";
}
