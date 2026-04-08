const path = require('path');

const CWD = __dirname;
const DIST = path.join(CWD, 'dist');
const LOGS = '/root/.pm2/logs';

module.exports = {
  apps: [
    {
      name: 'admin-server',
      script: path.join(DIST, 'index.js'),
      cwd: CWD,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      max_memory_restart: '256M',
      out_file: path.join(LOGS, 'admin-server-out.log'),
      error_file: path.join(LOGS, 'admin-server-error.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--enable-source-maps',
      },
      kill_timeout: 5000,
      shutdown_with_message: true,
    },
  ],
};
