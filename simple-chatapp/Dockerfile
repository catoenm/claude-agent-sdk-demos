FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund
COPY . .
RUN npm run build && mkdir -p /home/node/agent && chown node:node /home/node/agent
USER node
ENV HOST=0.0.0.0 PORT=3001
CMD ["node", "--import", "tsx", "server/server.ts"]
