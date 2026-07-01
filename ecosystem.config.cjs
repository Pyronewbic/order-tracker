// PM2 process definition.
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
// `cwd` is derived from this file's location, so it works wherever you clone
// the repo — no editing required.
module.exports = {
  apps: [
    {
      name: "order-tracker",
      script: "dist/index.js",
      cwd: __dirname,
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
