import { z } from "zod";

// Lease (temporary task ownership). Time-bound leases enable recovery when agents crash, unlike locks
export const LeaseSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  agentId: z.string(),
  expiresAt: z.date(), // auto-release on expiry
  createdAt: z.date(),
});
export type Lease = z.infer<typeof LeaseSchema>;

// Acquire lease input schema
export const AcquireLeaseInput = z.object({
  taskId: z.string().uuid(),
  agentId: z.string(),
  durationMinutes: z.number().int().positive().default(60),
});
export type AcquireLeaseInput = z.infer<typeof AcquireLeaseInput>;

// Check if lease is valid
export function isLeaseValid(lease: Lease): boolean {
  return lease.expiresAt > new Date();
}

// Get remaining lease time in ms
export function getLeaseRemainingMs(lease: Lease): number {
  return Math.max(0, lease.expiresAt.getTime() - Date.now());
}
