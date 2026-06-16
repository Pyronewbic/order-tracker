// PM2 process definition for the Mac mini.
//
// This package is ESM ("type": "module"), and PM2 loads its ecosystem file via
// CommonJS `require`, so this file is intentionally `.cjs`.
//
// Usage:
//   npm run build          # compile TypeScript → dist/
//   pm2 start ecosystem.config.cjs
//   pm2 save               # persist the process list
//   pm2 startup            # print the command to enable boot-time auto-start
//
// Adjust `cwd` if you clone the repo somewhere other than the path below.
module.exports = {
  apps: [
    {
      name: "order-tracker",
      script: "dist/index.js",
      cwd: "/Users/knambiar/Code/Personal/tracker",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000, // back off 5s between crash restarts
      kill_timeout: 10000, // give SIGTERM time to flush state + logs
      env: {
        NODE_ENV: "production",
      },
      // App writes its own tracker.log; these capture PM2/stdout framing.
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
