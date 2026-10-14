FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
RUN mkdir -p /app/data /shared && chown -R node:node /app /shared
USER node
ENV QBRIDGE_HOST=0.0.0.0 QBRIDGE_STATE_DIR=/app/data QBRIDGE_FILE_ROOT=/shared
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/cli.js", "serve"]
