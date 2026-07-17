FROM ghcr.io/puppeteer/puppeteer:23.4.0

USER root
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN chown -R pptruser:pptruser /app
USER pptruser

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
