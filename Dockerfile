FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY app ./app
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "app/server.js"]
