FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV HOST=0.0.0.0 \
    PORT=3000 \
    EVENTGO_NO_BROWSER=1 \
    EVENTGO_DATA_DIR=/data

RUN mkdir -p /data/uploads \
 && chown -R node:node /app /data

USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
