FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY README.md ./

RUN npm run build
RUN mkdir -p artifacts/screenshots artifacts/downloads playwright/.auth credentials

ENV NODE_ENV=production

CMD ["npm", "start"]
