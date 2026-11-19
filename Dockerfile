FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5174
ENV DATA_DIR=/app/data
USER node
EXPOSE 5174
CMD ["npm", "start"]
