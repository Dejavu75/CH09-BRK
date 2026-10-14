FROM node:22-alpine
WORKDIR /app

# SHA512-crypt verification uses htpasswd; native SQLite needs a build toolchain
# when no compatible Alpine prebuilt binary is available.
RUN apk add --no-cache git openssh-client apache2-utils

# Copy only package.json and package-lock.json to leverage Docker cache
COPY ./package.json ./package-lock.json ./

# Keep compilers out of the runtime image after native dependency installation.
RUN apk add --no-cache --virtual .native-build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .native-build-deps \
    && npm cache clean --force

# Copy the build directory
COPY ./build/ ./build/

# Copy startup helper that validates the externally mounted SSH identity.
COPY ./docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY ./scripts/state_bootstrap.cjs /app/scripts/state_bootstrap.cjs
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose necessary ports
EXPOSE 3000 80 443

# CMD npm start
##CMD ["tail", "-f", "/dev/null"]
ENTRYPOINT [ "docker-entrypoint.sh" ]
CMD [ "node", "build/app.js" ]
