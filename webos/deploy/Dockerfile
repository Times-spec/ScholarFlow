# 随行 · 智能游览助手 —— 零依赖运行镜像
# 构建：docker build -t smart-tour:0.1.0 -f deploy/Dockerfile .
# 运行：docker run -d --name smart-tour -p 8080:8080 -v $(pwd)/data:/app/data \
#         -e AMAP_WS_KEY=xxx -e AMAP_JS_KEY=xxx -e AMAP_JS_SECRET=xxx \
#         -e LLM_BASE_URL=https://api.deepseek.com/v1 -e LLM_API_KEY=xxx -e LLM_MODEL=deepseek-chat \
#         smart-tour:0.1.0
# 说明：项目无第三方依赖，因此只需拷贝源码，无需 npm install。
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# 只拷贝运行所需内容（密钥不进镜像，运行时用环境变量注入）
COPY server ./server
COPY web ./web
COPY package.json README.md ./

# 运行时数据目录（务必挂载卷，否则容器重建会丢行程记录）
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node
EXPOSE 8080

# 健康检查：/v1/config 无需鉴权，返回 200 即服务就绪
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
