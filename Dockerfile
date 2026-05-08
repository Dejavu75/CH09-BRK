FROM node:23-alpine
WORKDIR /app

# Install git and OpenSSH client tools.
RUN apk add --no-cache git openssh-client

# Generate the default SSH key used by maintenance scripts.
# Prefer mounting /app/keys as a secret/volume in production so the private key is not baked into the image.
RUN mkdir -p /app/keys \
    && ssh-keygen -t ed25519 -f /app/keys/ch09_brk_iis -C "ch09-brk-iis" -N ""

# Copy only package.json and package-lock.json to leverage Docker cache
COPY ./package.json ./package-lock.json ./

# Install dependencies and clean npm cache in a single step
RUN npm install && npm cache clean --force

# Copy the build directory
COPY ./build/ ./build/

# Copy startup helper that exports the public SSH key to a mounted directory.
COPY ./docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Upgrade npm packages
RUN npm upgrade

# Expose necessary ports
EXPOSE 3000 80 443

# CMD npm start
##CMD ["tail", "-f", "/dev/null"]
ENTRYPOINT [ "docker-entrypoint.sh" ]
CMD [ "node", "build/app.js" ]
