FROM node:20-slim

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
COPY package*.json ./

# Install production dependencies.
RUN npm install --only=production

# Copy local code to the container image.
COPY . .

# Cloud Run requires the server to listen on 8080.
ENV PORT 8080
EXPOSE 8080

# Start the server using the script defined in package.json.
CMD [ "npm", "start" ]
