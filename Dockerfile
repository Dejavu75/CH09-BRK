FROM node:23-alpine
WORKDIR /app

# Install git and clean up immediately to reduce image size
RUN apk add --no-cache git

# Copy only package.json and package-lock.json to leverage Docker cache
COPY ./package.json ./package-lock.json ./

# Install dependencies and clean npm cache in a single step
RUN npm install && npm cache clean --force

# Copy the build directory
COPY ./build/ ./build/

# Upgrade npm packages
RUN npm upgrade

# Expose necessary ports
EXPOSE 3000 80 443

# CMD npm start
##CMD ["tail", "-f", "/dev/null"]
CMD [ "node", "build/app.js" ]
