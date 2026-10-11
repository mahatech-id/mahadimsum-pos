FROM node:24-bookworm-slim

# pg-native links against libpq and compiles a native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libpq-dev python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
