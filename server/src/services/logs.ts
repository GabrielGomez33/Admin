import fs from 'fs';
import path from 'path';

const LOGS_DIR = process.env.PM2_LOGS_DIR || '/root/.pm2/logs';

export interface LogEntry {
  timestamp: string;
  line: string;
}

export interface LogFile {
  name: string;
  service: string;
  type: 'out' | 'error' | 'combined';
  size: string;
  modified: string;
}

export function listLogFiles(): LogFile[] {
  try {
    const files = fs.readdirSync(LOGS_DIR);
    return files
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const stat = fs.statSync(path.join(LOGS_DIR, f));
        const type = f.includes('-error') ? 'error' as const
          : f.includes('-combined') ? 'combined' as const
          : 'out' as const;
        const service = f.replace(/-out\.log$|-error\.log$|-combined\.log$/, '');

        return {
          name: f,
          service,
          type,
          size: formatBytes(stat.size),
          modified: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => a.service.localeCompare(b.service));
  } catch (error) {
    console.error('Failed to list log files:', error);
    return [];
  }
}

export function tailLog(filename: string, lines: number = 100): LogEntry[] {
  // Sanitize filename to prevent directory traversal
  const sanitized = path.basename(filename);
  if (!sanitized.endsWith('.log')) return [];

  const filePath = path.join(LOGS_DIR, sanitized);

  try {
    if (!fs.existsSync(filePath)) return [];

    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    // Read only the tail of the file to avoid ERR_STRING_TOO_LONG on huge logs
    const CHUNK_SIZE = Math.min(stat.size, lines * 1024); // ~1KB per line estimate
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(CHUNK_SIZE);
    fs.readSync(fd, buffer, 0, CHUNK_SIZE, stat.size - CHUNK_SIZE);
    fs.closeSync(fd);

    const chunk = buffer.toString('utf-8');
    const allLines = chunk.split('\n').filter(Boolean);
    // Drop first line (likely partial) unless we read the whole file
    const tailLines = CHUNK_SIZE < stat.size ? allLines.slice(1).slice(-lines) : allLines.slice(-lines);

    return tailLines.map(line => {
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}):?\s*/);
      return {
        timestamp: tsMatch ? tsMatch[1] : '',
        line: tsMatch ? line.substring(tsMatch[0].length) : line,
      };
    });
  } catch (error) {
    console.error(`Failed to read log file ${sanitized}:`, error);
    return [];
  }
}

export function getRecentErrors(maxLines: number = 50): { service: string; entries: LogEntry[] }[] {
  const errorFiles = listLogFiles().filter(f => f.type === 'error');
  return errorFiles.map(f => ({
    service: f.service,
    entries: tailLog(f.name, maxLines),
  })).filter(s => s.entries.length > 0);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
