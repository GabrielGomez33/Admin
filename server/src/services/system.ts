import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  uptime: string;
  uptimeSeconds: number;
  loadAverage: number[];
  memory: {
    total: string;
    used: string;
    free: string;
    usagePercent: number;
  };
  cpu: {
    model: string;
    cores: number;
  };
  disk: {
    total: string;
    used: string;
    available: string;
    usagePercent: number;
  } | null;
  timestamp: string;
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let disk: SystemInfo['disk'] = null;
  try {
    const { stdout } = await execAsync("df -B1 / | tail -1 | awk '{print $2,$3,$4,$5}'");
    const [total, used, available, percent] = stdout.trim().split(/\s+/);
    disk = {
      total: formatBytes(parseInt(total)),
      used: formatBytes(parseInt(used)),
      available: formatBytes(parseInt(available)),
      usagePercent: parseInt(percent),
    };
  } catch { /* non-critical */ }

  const uptimeSeconds = os.uptime();

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    nodeVersion: process.version,
    uptime: formatUptime(uptimeSeconds),
    uptimeSeconds,
    loadAverage: os.loadavg().map(l => Math.round(l * 100) / 100),
    memory: {
      total: formatBytes(totalMem),
      used: formatBytes(usedMem),
      free: formatBytes(freeMem),
      usagePercent: Math.round((usedMem / totalMem) * 100),
    },
    cpu: {
      model: os.cpus()[0]?.model || 'unknown',
      cores: os.cpus().length,
    },
    disk,
    timestamp: new Date().toISOString(),
  };
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
