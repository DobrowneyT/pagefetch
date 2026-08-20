# The Playwright image ships Chromium with the system libraries already present,
# which is the tedious part to get right by hand. The tag MUST match the
# playwright version in package.json — the image's pre-installed browsers are
# what stops `npm ci` downloading its own copy.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc

FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The persistent profile lives here. It is the single most valuable piece of
# state this service holds: a browser that has been to a site before and kept
# its cookies looks far less robotic than a cold one.
RUN mkdir -p /data/profile && chown -R pwuser:pwuser /data
VOLUME ["/data"]

USER pwuser
EXPOSE 8790
CMD ["node", "dist/src/index.js"]
