#DOCKERFILE CONFIG

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
ENV FFMPEG_PATH=/usr/bin/ffmpeg
COPY package.json yarn.lock* package-lock.json* ./
RUN yarn install --production || npm install --production
COPY . .
RUN mkdir -p /app/data/uploads
RUN mkdir -p /app/data/processed 
EXPOSE 3000
CMD ["node", "index.js"]
