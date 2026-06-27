/**
 * PM2 Ecosystem Configuration
 * Run: pm2 start ecosystem.config.js
 */
'use strict';
module.exports = {
  apps: [
    {
      name:           'sylcloud-cattle',
      script:         'src/index.js',
      instances:      1,           // Single instance — TCP socket state is in-process
      exec_mode:      'fork',      // NOT cluster — TCP persistent connections need single process
      watch:          false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      error_file:     'logs/error.log',
      out_file:       'logs/out.log',
      log_date_format:'YYYY-MM-DD HH:mm:ss Z',
      merge_logs:     true,
      restart_delay:  5000,
      max_restarts:   10,
      autorestart:    true,
      kill_timeout:   10000,       // 10 s graceful shutdown window
    },
  ],
};
