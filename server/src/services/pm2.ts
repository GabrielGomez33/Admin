import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface PM2Process {
  name: string;
  pid: number;
  status: string;
  cpu: number;
  memory: number;
  memoryMB: string;
  uptime: number;
  uptimeFormatted: string;
  restarts: number;
  user: string;
  createdAt: number;
}

export async function getPM2Processes(): Promise<PM2Process[]> {
  try {
    const { stdout } = await execAsync('sudo pm2 jlist', { timeout: 10000 });
    const processes = JSON.parse(stdout);

    return processes.map((proc: any) => ({
      name: proc.name,
      pid: proc.pid,
      status: proc.pm2_env?.status || 'unknown',
      cpu: proc.monit?.cpu || 0,
      memory: proc.monit?.memory || 0,
      memoryMB: ((proc.monit?.memory || 0) / 1024 / 1024).toFixed(1) + ' MB',
      uptime: proc.pm2_env?.pm_uptime || 0,
      uptimeFormatted: formatUptime(proc.pm2_env?.pm_uptime || 0),
      restarts: proc.pm2_env?.restart_time || 0,
      user: proc.pm2_env?.username || 'unknown',
      createdAt: proc.pm2_env?.created_at || 0,
    }));
  } catch (error) {
    console.error('Failed to fetch PM2 data:', error);
    return [];
  }
}

function formatUptime(startTimestamp: number): string {
  if (!startTimestamp) return 'N/A';
  const elapsed = Date.now() - startTimestamp;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
