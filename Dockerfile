FROM ghcr.io/puppeteer/puppeteer:23.4.0

USER root
WORKDIR /app

# A imagem oficial já traz Chrome — NÃO baixar de novo no build (estoura Render free).
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer
ENV PUPPETEER_DOCKER=1
ENV NODE_ENV=production
# Plano free ~512MB
ENV NODE_OPTIONS=--max-old-space-size=128
ENV GIAP_MAX_BUSCAS_NOME=25
ENV GIAP_MAX_VARIANTES_NOME=4
ENV GIAP_BULK_AZ=0
ENV GIAP_BULK_PREFIXOS_MAX=15
ENV GIAP_HTTP_DIRECT=0
ENV GIAP_SCRAPE_TIMEOUT_MS=30000
ENV GIAP_RESTART_BROWSER_AFTER_N=10
ENV GIAP_BROWSER_RESTART_EVERY=20
ENV GIAP_CLOSE_BROWSER_EVERY_NOME=999
ENV GIAP_BULK_META=400
ENV GIAP_AUTO_CONTINUAR=1
ENV GIAP_CONTINUAR_DELAY_MS=5000
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && mkdir -p /home/pptruser/.cache/puppeteer \
  && chown -R pptruser:pptruser /home/pptruser/.cache /app

COPY src ./src
RUN chown -R pptruser:pptruser /app

USER pptruser

EXPOSE 3000
CMD ["node", "src/server.js"]
