FROM node:20-alpine

RUN apk add --no-cache python3 make g++ tar

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src/ ./src/

RUN mkdir -p /data/servers

EXPOSE 3000

CMD ["node", "src/index.js"]
