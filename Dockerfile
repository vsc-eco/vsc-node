FROM node:16 AS build

WORKDIR /vsc-node-build

COPY package*.json ./

RUN npm install --legacy-peer-deps

COPY . .

RUN npm run build


FROM node:16

WORKDIR /vsc-node

COPY --from=build /vsc-node-build/dist ./dist

COPY package*.json ./

RUN npm install --legacy-peer-deps --omit=dev

EXPOSE 1337

CMD [ "node", "--experimental-specifier-resolution=node", "--max-old-space-size=3072", "--no-node-snapshot", "dist/index.js"]