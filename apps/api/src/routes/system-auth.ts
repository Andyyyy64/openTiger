// system系の操作が許可されているか判定する
export function canControlSystem(method: string): boolean {
  if (method === "api-key" || method === "bearer") {
    return true;
  }
  // ローカル運用時の安全弁として明示的に無効化できるようにする
  return process.env.OPENTIGER_ALLOW_INSECURE_SYSTEM_CONTROL !== "false";
}
