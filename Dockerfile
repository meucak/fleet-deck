FROM node:20-alpine

RUN apk add --no-cache openssh-client wget

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY scripts/entrypoint.sh /usr/local/bin/fleet-entrypoint.sh
RUN chmod +x /usr/local/bin/fleet-entrypoint.sh

COPY server ./server
COPY public ./public

ENV PORT=8091
ENV NODE_ENV=production
EXPOSE 8091

ENTRYPOINT ["/usr/local/bin/fleet-entrypoint.sh"]
CMD ["node", "server/index.js"]
