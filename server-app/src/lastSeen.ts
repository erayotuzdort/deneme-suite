const lastSeen = new Map<string, Date>();

export function touch(deviceId: string): void {
  lastSeen.set(deviceId.toLowerCase(), new Date());
}

export function getLastSeen(deviceId: string): Date | null {
  return lastSeen.get(deviceId.toLowerCase()) ?? null;
}
