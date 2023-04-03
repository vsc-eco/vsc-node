FROM node:16

# Create app directory
WORKDIR /home/github/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install --legacy-peer-deps
# If you are building your code for production
# RUN npm ci --only=production

#RUN rm dist

# Bundle app source
COPY . .

RUN npm run build

CMD [ "npm", "run", "dev" ]
