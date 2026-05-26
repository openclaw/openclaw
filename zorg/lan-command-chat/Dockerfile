FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
ARG BUILD_TAG="dev"
ENV NEXT_PUBLIC_BUILD_TAG=$BUILD_TAG
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
