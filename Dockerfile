FROM node:24-alpine
WORKDIR /app
LABEL org.opencontainers.image.title="Arenode" \
      org.opencontainers.image.description="Multi-tenant CDN resource management console" \
      org.opencontainers.image.licenses="MIT"
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
USER node
ENV NODE_ENV=production PORT=3080
EXPOSE 3080
CMD ["node", "src/server.js"]
