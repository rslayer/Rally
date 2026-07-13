# Rally control-tower dashboard — a stateless Node server, no build step.
FROM node:22-slim

WORKDIR /app

# Install runtime deps only (tsx runs the TypeScript directly).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (tsx resolves the @rally/* path aliases from tsconfig.json).
COPY . .

ENV NODE_ENV=production
ENV PORT=8137
EXPOSE 8137

# The platform's $PORT (if set) overrides the default.
CMD ["npm", "start"]
