FROM node:22-alpine
WORKDIR /app

# Install git and OpenSSH client tools.
RUN apk add --no-cache git openssh-client

# Copy only package.json and package-lock.json to leverage Docker cache
COPY ./package.json ./package-lock.json ./

# Install dependencies and clean npm cache in a single step
RUN npm install && npm cache clean --force

# Copy the build directory
COPY ./build/ ./build/

# Copy startup helper that validates the externally mounted SSH identity.
COPY ./docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose necessary ports
EXPOSE 3000 80 443

# CMD npm start
##CMD ["tail", "-f", "/dev/null"]
ENTRYPOINT [ "docker-entrypoint.sh" ]
CMD [ "node", "build/app.js" ]
