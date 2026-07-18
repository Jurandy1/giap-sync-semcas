FROM ghcr.io/puppeteer/puppeteer:23.4.0

USER root
WORKDIR /app

# Cache do Chrome no home do pptruser (mesmo usuário que roda o app)
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer
ENV PUPPETEER_DOCKER=1
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=192
ENV GIAP_MAX_BUSCAS_NOME=20
ENV GIAP_BROWSER_RESTART_EVERY=20
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev \
  && npx puppeteer browsers install chrome \
  && npm cache clean --force \
  && mkdir -p /home/pptruser/.cache/puppeteer \
  && chown -R pptruser:pptruser /home/pptruser/.cache /app

COPY src ./src
RUN chown -R pptruser:pptruser /app

USER pptruser

EXPOSE 3000
CMD ["node", "src/server.js"]
