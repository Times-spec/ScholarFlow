// pm2 配置：pm2 start deploy/ecosystem.config.js
// 密钥建议用环境变量注入（或把 config.json 放在项目根，pm2 会继承该目录）
module.exports = {
  apps: [
    {
      name: 'smart-tour',
      script: 'server/index.js',
      cwd: __dirname + '/..',
      instances: 1,              // JSON 文件存储按单实例设计，勿开 cluster
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
        // AMAP_WS_KEY: '你的高德Web服务Key',
        // AMAP_JS_KEY: '你的高德JSKey',
        // AMAP_JS_SECRET: '你的高德安全密钥',
        // LLM_BASE_URL: 'https://api.deepseek.com/v1',
        // LLM_API_KEY: '你的LLM密钥',
        // LLM_MODEL: 'deepseek-chat',
      },
      out_file: './logs/out.log',
      error_file: './logs/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
